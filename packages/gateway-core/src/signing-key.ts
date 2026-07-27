import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";

export interface CoreSigningKey {
  keyId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeySpkiBase64: string;
}

export function loadOrCreateCoreSigningKey(path: string): CoreSigningKey {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, pem, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  }
  chmodSync(path, 0o600);
  const privateKey = createPrivateKey(readFileSync(path));
  const publicKey = createPublicKey(privateKey);
  const publicKeySpkiBase64 = publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
  const keyId = `core-${createHash("sha256")
    .update(Buffer.from(publicKeySpkiBase64, "base64"))
    .digest("hex")
    .slice(0, 24)}`;
  return { keyId, privateKey, publicKey, publicKeySpkiBase64 };
}
