#!/usr/bin/env python3
"""Open a botato backup without botato.

    python3 scripts/open-backup.py botato-2026-08-25-1232.backup out/

An encrypted backup you can only read with the program that died is not a
backup, so this exists and is tested against real archives. It needs nothing
but `cryptography`, which most machines with Python already have:

    pip install cryptography

What comes out is an ordinary directory: `state.json` holds every conversation,
channel, thread, pin and routine as the window keeps them, and `bots/` holds
each bot's memory file and workspace.

The format, which is also written down in src-tauri/src/backup.rs:

    offset  size  what
         0     8  magic, b"BOTATO\\0\\x01"
         8     1  key derivation: 1 = argon2id
         9     4  memory cost, KiB, little-endian u32
        13     4  time cost, little-endian u32
        17     1  parallelism
        18    16  salt
        34    24  nonce
        58     …  XChaCha20-Poly1305 ciphertext of a gzipped tar

The whole 58-byte header is the associated data, so the cost parameters cannot
be edited down without the tag failing.
"""

import getpass
import gzip
import io
import struct
import sys
import tarfile
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from cryptography.hazmat.primitives.kdf.argon2 import Argon2id

MAGIC = b"BOTATO\0\x01"
# Backups written before the rename. Still opened, so a botcage backup can be
# recovered by a botato that never wrote one.
MAGIC_WAS = b"BOTCAGE\x01"
HEADER = 58


def hchacha20(key: bytes, nonce16: bytes) -> bytes:
    """The subkey derivation that makes XChaCha20 out of ChaCha20.

    A ChaCha20 double-round block, with the first and last rows returned
    instead of being added to the input. Written out because `cryptography`
    ships ChaCha20-Poly1305 with a 12-byte nonce and not the extended one.
    """
    mask = 0xFFFFFFFF

    def rotl(v, n):
        return ((v << n) | (v >> (32 - n))) & mask

    state = [0x61707865, 0x3320646E, 0x79622D32, 0x6B206574]
    state += list(struct.unpack("<8I", key))
    state += list(struct.unpack("<4I", nonce16))

    def quarter(a, b, c, d):
        state[a] = (state[a] + state[b]) & mask
        state[d] = rotl(state[d] ^ state[a], 16)
        state[c] = (state[c] + state[d]) & mask
        state[b] = rotl(state[b] ^ state[c], 12)
        state[a] = (state[a] + state[b]) & mask
        state[d] = rotl(state[d] ^ state[a], 8)
        state[c] = (state[c] + state[d]) & mask
        state[b] = rotl(state[b] ^ state[c], 7)

    for _ in range(10):
        quarter(0, 4, 8, 12)
        quarter(1, 5, 9, 13)
        quarter(2, 6, 10, 14)
        quarter(3, 7, 11, 15)
        quarter(0, 5, 10, 15)
        quarter(1, 6, 11, 12)
        quarter(2, 7, 8, 13)
        quarter(3, 4, 9, 14)

    return struct.pack("<8I", *(state[:4] + state[12:16]))


def open_backup(sealed: bytes, passphrase: str) -> bytes:
    if len(sealed) < HEADER or sealed[:8] not in (MAGIC, MAGIC_WAS):
        raise SystemExit("that is not a botato backup")

    header = sealed[:HEADER]
    if header[8] != 1:
        raise SystemExit("unknown key derivation — a later botato made this")

    memory_kib, passes = struct.unpack("<II", header[9:17])
    lanes = header[17]
    salt = header[18:34]
    nonce = header[34:58]

    key = Argon2id(
        salt=salt,
        length=32,
        iterations=passes,
        lanes=lanes,
        memory_cost=memory_kib,
    ).derive(passphrase.encode())

    # XChaCha20-Poly1305: an HChaCha20 subkey from the first 16 nonce bytes,
    # then ordinary ChaCha20-Poly1305 with four zero bytes and the last eight.
    subkey = hchacha20(key, nonce[:16])
    inner = b"\x00\x00\x00\x00" + nonce[16:]

    try:
        plain = ChaCha20Poly1305(subkey).decrypt(inner, sealed[HEADER:], header)
    except Exception:
        raise SystemExit("wrong passphrase, or this backup is damaged")
    return gzip.decompress(plain)


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(f"usage: {sys.argv[0]} <backup file> <directory to write>")

    sealed = Path(sys.argv[1]).read_bytes()
    into = Path(sys.argv[2])
    passphrase = getpass.getpass("Passphrase: ")

    tarball = open_backup(sealed, passphrase)
    into.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(tarball)) as tar:
        for member in tar.getmembers():
            # A backup has been somewhere else, and a tar entry named ../ is the
            # oldest trick there is. Ours never has one.
            if member.name.startswith("/") or ".." in Path(member.name).parts:
                raise SystemExit(f"refusing to write outside {into}: {member.name}")
        tar.extractall(into)

    print(f"opened into {into}")
    print("  state.json — every conversation, channel, thread, pin and routine")
    print("  bots/      — each bot's memory file and workspace")


if __name__ == "__main__":
    main()
