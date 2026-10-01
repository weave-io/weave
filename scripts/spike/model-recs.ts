/**
 * SPIKE (Spec 39) tooling. Throwaway.
 *   bun scripts/spike/model-recs.ts keygen <dir>
 *   bun scripts/spike/model-recs.ts sign <keydir> <file.json>
 *   bun scripts/spike/model-recs.ts serve <dir> <port>
 */
import { join } from "node:path";

const [command, a, b] = Bun.argv.slice(2);
const b64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

if (command === "keygen") {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  await Bun.write(join(a!, "public.b64"), b64(await crypto.subtle.exportKey("raw", kp.publicKey)));
  await Bun.write(join(a!, "private.pkcs8.b64"), b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey)));
  process.stdout.write(`keys written to ${a}\n`);
} else if (command === "sign") {
  const pkcs8 = Uint8Array.from(atob(await Bun.file(join(a!, "private.pkcs8.b64")).text()), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  const bytes = new Uint8Array(await Bun.file(b!).arrayBuffer());
  await Bun.write(`${b}.sig`, b64(await crypto.subtle.sign("Ed25519", key, bytes)));
  process.stdout.write(`signed ${b}\n`);
} else if (command === "serve") {
  const server = Bun.serve({
    port: Number(b),
    async fetch(request) {
      const path = join(a!, new URL(request.url).pathname);
      const file = Bun.file(path);
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      const etag = `"${new Bun.CryptoHasher("sha256").update(await file.arrayBuffer()).digest("hex").slice(0, 16)}"`;
      process.stdout.write(`${new Date().toISOString()} GET ${new URL(request.url).pathname} inm=${request.headers.get("if-none-match")}\n`);
      if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
      return new Response(file, { headers: { etag, "content-type": "application/json", "cache-control": "public, max-age=300" } });
    },
  });
  process.stdout.write(`serving ${a} on ${server.port}\n`);
}
