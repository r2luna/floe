#!/bin/bash
# Reproducible Arch test VM for the Rookery server, on an Apple-Silicon Mac via QEMU.
#
# Boots the OFFICIAL Arch x86_64 cloud image (has cloud-init) under TCG emulation, seeds a
# `rookery` user + SSH key via a NoCloud CIDATA ISO, and forwards guest 22/41600 to the
# host. Then deploy out/ + bin/ and run `rookery server setup && up` inside it.
#
# Gotcha learned the hard way: `hdiutil makehybrid -hfs` puts the volume name only on the
# HFS side; cloud-init reads the ISO9660 label via blkid, which stays "APPLE INC." → the
# NoCloud datasource never matches (DataSourceNone) and no user is created. Build the seed
# WITHOUT -hfs so the ISO9660 label is really CIDATA.
set -euo pipefail
VM=~/rookery-vm
IMG_URL=https://geo.mirror.pkgbuild.com/images/latest/Arch-Linux-x86_64-cloudimg.qcow2
mkdir -p "$VM"; cd "$VM"

[ -f base.qcow2 ] || curl -L -o base.qcow2 "$IMG_URL"
[ -f id_rookery ] || ssh-keygen -t ed25519 -N "" -f id_rookery -C rookery-vm

mkdir -p seed
cat > seed/meta-data <<EOF
instance-id: rookery-arch-01
local-hostname: rookery-arch
EOF
cat > seed/user-data <<EOF
#cloud-config
users:
  - name: rookery
    sudo: ALL=(ALL) NOPASSWD:ALL
    groups: wheel
    shell: /bin/bash
    lock_passwd: false
    ssh_authorized_keys:
      - $(cat id_rookery.pub)
growpart: { mode: auto }
EOF
# ISO9660 label MUST be CIDATA (no -hfs). cloud-init/blkid reads this label.
rm -f seed.iso
hdiutil makehybrid -o seed.iso -iso -joliet -default-volume-name CIDATA seed >/dev/null

[ -f disk.qcow2 ] || { cp base.qcow2 disk.qcow2; qemu-img resize disk.qcow2 20G; }
cp -f /opt/homebrew/share/qemu/edk2-i386-vars.fd vars.fd

echo "booting (TCG — first cloud-init boot takes minutes)…"
exec qemu-system-x86_64 \
  -name rookery-arch -machine q35 -accel tcg,thread=multi -cpu qemu64 -smp 4 -m 6144 \
  -drive if=pflash,format=raw,readonly=on,file=/opt/homebrew/share/qemu/edk2-x86_64-code.fd \
  -drive if=pflash,format=raw,file=vars.fd \
  -drive file=disk.qcow2,if=virtio,format=qcow2 \
  -drive file=seed.iso,if=virtio,media=cdrom \
  -netdev user,id=n0,hostfwd=tcp:127.0.0.1:2222-:22,hostfwd=tcp:127.0.0.1:41600-:41600 \
  -device virtio-net,netdev=n0 -display none -serial file:"$VM/serial.log"

# Then, from the Mac:
#   ssh -i ~/rookery-vm/id_rookery -p 2222 rookery@127.0.0.1
#   # deploy: tar czf - out bin package.json | ssh … 'tar xzf - -C ~/rookery'
#   # on VM:  npm install   (node-pty native build; add --strict-ssl=false behind MITM proxies)
#   #         ROOKERY_HOST=0.0.0.0 node bin/rookery-server.mjs setup && rookery server up
#   # browser (Mac): http://127.0.0.1:41600/?token=$(cat ~/.rookery/rookery-token on VM)
# To import into UTM instead: UTM → Create → Emulate → Linux → use disk.qcow2 as the drive.
