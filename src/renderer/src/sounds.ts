// The turn-done sounds, synthesized with Web Audio.
//
// Recipes rather than audio files: every sound is a handful of oscillators with
// an envelope, so the whole palette ships in this file — nothing to bundle,
// nothing to license, and Settings can preview a pick by just playing it.

import type { NotifySoundId } from '../../shared/types'

let ctx: AudioContext | null = null

function audioContext(): AudioContext {
  if (!ctx) ctx = new AudioContext()
  return ctx
}

/**
 * One decaying note: an oscillator through a gain envelope, cleaned up when it
 * ends. `at` is seconds from now, so a recipe schedules its notes in one call.
 */
function note(
  ac: AudioContext,
  freq: number,
  at: number,
  duration: number,
  peak: number,
  type: OscillatorType = 'sine'
): void {
  const start = ac.currentTime + at
  const osc = ac.createOscillator()
  const gain = ac.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, start)
  // A short attack ramp instead of starting at peak — a gain that jumps from
  // zero clicks audibly.
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  osc.connect(gain)
  gain.connect(ac.destination)
  osc.start(start)
  osc.stop(start + duration + 0.05)
  osc.onended = () => {
    osc.disconnect()
    gain.disconnect()
  }
}

const RECIPES: Record<Exclude<NotifySoundId, 'off'>, (ac: AudioContext) => void> = {
  // Two soft notes a fifth apart — the default, meant to be heard many times a
  // day without wearing out.
  chime: (ac) => {
    note(ac, 1046.5, 0, 0.4, 0.12) // C6
    note(ac, 1568, 0.12, 0.5, 0.12) // G6
  },
  // A single high sine, sonar-style.
  ping: (ac) => {
    note(ac, 1760, 0, 0.5, 0.15) // A6
  },
  // A quick upward blip, the shortest of the set.
  pop: (ac) => {
    const start = ac.currentTime
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(440, start)
    osc.frequency.exponentialRampToValueAtTime(880, start + 0.1)
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(0.2, start + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.15)
    osc.connect(gain)
    gain.connect(ac.destination)
    osc.start(start)
    osc.stop(start + 0.2)
    osc.onended = () => {
      osc.disconnect()
      gain.disconnect()
    }
  },
  // One strike with inharmonic partials — the stretched ratios are what makes
  // it read as glass rather than an organ.
  bell: (ac) => {
    note(ac, 880, 0, 0.9, 0.12)
    note(ac, 880 * 2.4, 0, 0.6, 0.05)
    note(ac, 880 * 5.1, 0, 0.35, 0.02)
  },
  // Two low wooden notes: fundamental plus the bar's fourth partial, dying fast.
  marimba: (ac) => {
    for (const [freq, at] of [
      [523.25, 0],
      [659.25, 0.14]
    ]) {
      note(ac, freq, at, 0.3, 0.18)
      note(ac, freq * 4, at, 0.1, 0.05)
    }
  },
  // A rising major arpeggio, the celebratory one.
  tada: (ac) => {
    const steps = [523.25, 659.25, 784, 1046.5] // C5 E5 G5 C6
    steps.forEach((freq, i) => note(ac, freq, i * 0.09, i === 3 ? 0.5 : 0.15, 0.14))
  }
}

/** Play unconditionally — what Settings uses to preview a pick. */
export function previewSound(sound: NotifySoundId): void {
  if (sound === 'off') return
  try {
    const ac = audioContext()
    // The context starts suspended until a user gesture in some Chromium
    // states; resume is a no-op when it is already running.
    void ac.resume()
    RECIPES[sound](ac)
  } catch {
    /* no audio device — the turn still ended, silently */
  }
}

// Several sessions can finish in the same tick; one sound is the news, five
// stacked are a fault.
let lastPlayed = 0

export function playDoneSound(sound: NotifySoundId): void {
  if (sound === 'off') return
  const now = Date.now()
  if (now - lastPlayed < 300) return
  lastPlayed = now
  previewSound(sound)
}
