import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Destravar a passphrase de assinatura (GPG) ou a chave SSH pela UI do Rookery,
// SEM o Rookery jamais tocar no segredo: a passphrase vai do teclado do usuário
// direto pro pinentry/ssh-add DENTRO de um PTY visível. Aqui só rodamos
// verificações (que não carregam segredo) e montamos o comando de destravamento.

export type UnlockKind = 'gpg' | 'ssh'

// Resolvido por existência de arquivo (não por PATH) pra valer tanto no desktop
// (macOS, Homebrew) quanto na box headless (Linux, systemd) — o PATH de um launch
// GUI/serviço é mínimo, então checar caminhos absolutos é mais confiável.
const BIN_PREFIXES = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']

function resolveBin(names: string[]): string | undefined {
  for (const n of names) for (const p of BIN_PREFIXES) if (existsSync(join(p, n))) return join(p, n)
  return undefined
}

// Um pinentry que funciona DENTRO do PTY sem sessão gráfica: curses/tty (Linux e
// macOS) ou pinentry-mac (só existe no macOS, que sempre tem GUI). O `pinentry`
// genérico fica de fora de propósito — na box ele cai num gnome3/qt que falha
// headless (é exatamente o bug que a feature conserta).
function resolvePinentry(): string | undefined {
  return resolveBin(['pinentry-curses', 'pinentry-tty', 'pinentry-mac'])
}

// A chave SSH a destravar: a primeira que existir entre os nomes comuns (a box
// usa a `_personal`; local pode ser outra), com fallback pra nomeada no pedido.
function resolveSshKey(): string {
  const dir = join(homedir(), '.ssh')
  const names = ['id_ed25519_personal', 'id_ed25519', 'id_ecdsa', 'id_rsa']
  for (const n of names) if (existsSync(join(dir, n))) return join(dir, n)
  return join(dir, 'id_ed25519_personal')
}

// Roda um comando e resolve com o exit code (0 = sucesso). Nunca rejeita —
// um exit não-zero é um resultado normal (chave travada), não um erro do app.
function exitCode(cmd: string, args: string[], stdin?: string): Promise<number> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: 10_000 }, (err) => {
      resolve(err ? (((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) as number) : 0)
    })
    if (stdin != null) child.stdin?.end(stdin)
  })
}

// A chave de assinatura do git (nunca hardcodar — ler do config). Vazio se não
// configurada.
function signingKey(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['config', '--get', 'user.signingkey'], { cwd, timeout: 5_000 }, (_e, out) =>
      resolve((out ?? '').trim())
    )
  })
}

// Já está destravado? gpg: uma assinatura batch (que NÃO consegue pedir
// passphrase) só passa se o agent já tem a chave em cache. ssh: o agent lista
// alguma identidade. ponytail: ssh checa "tem alguma chave", não a específica.
export async function isUnlocked(kind: UnlockKind, cwd: string): Promise<boolean> {
  if (kind === 'gpg') {
    const key = await signingKey(cwd)
    if (!key) return false
    const code = await exitCode(
      'gpg',
      ['--batch', '--no-tty', '--local-user', key, '--clearsign', '-o', '/dev/null'],
      'rookery-unlock-probe\n'
    )
    return code === 0
  }
  return (await exitCode('ssh-add', ['-l'])) === 0
}

// `key` vem do .git/config do repo — um repo clonado hostil poderia injetar
// metacaracteres de shell (o key vira `sh -c '… ${key} …'`). Um signingkey real é
// fingerprint/keyid hex ou um user-id/email: nada disso precisa de metacaractere.
export function isSafeSigningKey(key: string): boolean {
  return /^[A-Za-z0-9@._+\-<> ]{1,128}$/.test(key)
}

// O comando (POSIX, via `sh -c`) que roda no PTY visível e dispara o
// pinentry/ssh-add. Usa `sh -c` pra ser independente do shell de login (fish).
export async function unlockCommand(kind: UnlockKind, cwd: string): Promise<string> {
  if (kind === 'ssh') return `sh -c 'ssh-add ${resolveSshKey()}'`
  const key = await signingKey(cwd)
  if (!key) throw new Error('No git user.signingkey configured — set it with `git config user.signingkey <keyid>`.')
  if (!isSafeSigningKey(key)) {
    throw new Error('Refusing a suspicious git user.signingkey value (unexpected characters).')
  }
  // --clearsign (com tty, sem --batch) faz o gpg-agent chamar o pinentry-curses,
  // que desenha no PTY; a assinatura vai pro lixo — só primamos o cache.
  return `sh -c 'echo rookery-unlock | gpg --local-user ${key} --clearsign -o /dev/null && printf "\\n  GPG destravado.\\n" || printf "\\n  falhou ou cancelado.\\n"'`
}

// Um `pinentry-program` já configurado (não uma linha comentada). O `[ \t]*` no
// início NÃO cruza `#`, então `# pinentry-program …` não conta.
export function hasPinentryProgram(confBody: string): boolean {
  return /^[ \t]*pinentry-program[ \t]+\S/m.test(confBody)
}

// Garante que o gpg-agent tenha um pinentry que funcione dentro do PTY. Sem TTY
// nem sessão gráfica (a box headless), o pinentry genérico cai num backend GUI e
// falha ("Inappropriate ioctl for device"). Nunca falha em silêncio:
// - já tem `pinentry-program` no conf → respeita a escolha do usuário (vale local
//   com pinentry-mac e remoto com curses).
// - não tem, e achamos um pinentry curses/tty/mac → escreve a linha e recarrega.
// - não tem, e nenhum existe → erro claro (instale pinentry-curses).
export function ensurePinentry(): { ok: boolean; note?: string; error?: string } {
  const conf = join(homedir(), '.gnupg', 'gpg-agent.conf')
  let body = ''
  try {
    body = readFileSync(conf, 'utf8')
  } catch {
    /* conf ainda não existe */
  }
  if (hasPinentryProgram(body)) return { ok: true }
  const pinentry = resolvePinentry()
  if (!pinentry) {
    return {
      ok: false,
      error:
        'GPG precisa de um pinentry de TTY, mas não achei pinentry-curses/tty/mac em /usr/bin, /opt/homebrew/bin ou /usr/local/bin. Instale-o (Linux: pacman -S pinentry / apt install pinentry-curses; macOS: brew install pinentry-mac) e tente de novo.'
    }
  }
  try {
    mkdirSync(join(homedir(), '.gnupg'), { recursive: true, mode: 0o700 })
    const prefix = body && !body.endsWith('\n') ? '\n' : ''
    appendFileSync(conf, `${prefix}pinentry-program ${pinentry}\n`)
    void exitCode('gpgconf', ['--kill', 'gpg-agent']) // recarrega o agent
    return { ok: true, note: `Configurei ${conf} com pinentry-program ${pinentry}.` }
  } catch (e) {
    return { ok: false, error: `Não consegui escrever ${conf}: ${(e as Error).message}` }
  }
}

// Espera até destravar (poll da checagem) ou estourar o timeout.
export async function pollUnlocked(kind: UnlockKind, cwd: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500))
    if (await isUnlocked(kind, cwd)) return true
  }
  return false
}
