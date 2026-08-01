/**
 * Capture ECPay AES-JSON ReturnURL notifies, decrypt them, and log them in a shape
 * you can paste straight into a fixtures file.
 *
 * Exists because a notify cannot be provoked from a test: ECPay only POSTs one
 * after a real payment or a manual 模擬付款 click, and only to a publicly reachable
 * HTTPS URL. This is step 1 of that loop.
 *
 * Usage:
 *   pnpm capture:ecpay-notify                 # listens on :8787
 *   PORT=9000 pnpm capture:ecpay-notify
 *
 * Then, in another shell:
 *   cloudflared tunnel --url http://localhost:8787
 *   # → https://<random>.trycloudflare.com   (a CDN hostname; ECPay's
 *   #   介接注意事項 says to avoid those, but it does work — verified 2026-08-01)
 *
 * Point a 取號 at it and trigger the notify:
 *   1. createPayment({ ..., notifyUrl: "https://<tunnel>/notify" }) for each method
 *   2. vendor-stage.ecpay.com.tw → 一般訂單查詢 → 全方位金流訂單 → find the order
 *      → 模擬付款
 *
 * Credentials default to ECPay's public stage merchant; override with
 * ECPAY_HASH_KEY / ECPAY_HASH_IV for a real merchant.
 *
 * Raw records (headers included) are appended to OUT as JSONL so the transport
 * details survive too — the notify arrives as `Content-Type: application/json`
 * with `Accept: text/html` from an MSIE 9 user-agent.
 */
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { ECPAY_SANDBOX } from "../packages/payment-ecpay/src/config.ts";
import { decryptData } from "../packages/payment-ecpay/src/ecpg/aes.ts";

const PORT = Number(process.env.PORT ?? 8787);
const OUT = process.env.OUT ?? "ecpay-notify-capture.jsonl";
const HASH_KEY = process.env.ECPAY_HASH_KEY ?? ECPAY_SANDBOX.hashKey;
const HASH_IV = process.env.ECPAY_HASH_IV ?? ECPAY_SANDBOX.hashIv;

/** ECPay accepts nothing but this exact string; anything else triggers 4 retries. */
const ACK = "1|OK";

let seen = 0;

createServer((req, res) => {
  if (req.method === "GET") {
    // Handy for checking the tunnel is up before involving ECPay.
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ecpay-notify-capture ok");
    return;
  }

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    appendFileSync(
      OUT,
      `${JSON.stringify({ at: new Date().toISOString(), url: req.url, headers: req.headers, raw })}\n`,
    );

    // ACK first: ECPay's retry timer does not care whether we could decrypt.
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(ACK);

    console.log(`\n── notify #${++seen} ${new Date().toISOString()} ${req.url}`);
    console.log(`   ${req.headers["content-type"]} | accept: ${req.headers.accept}`);
    console.log(`   ua: ${req.headers["user-agent"]}`);
    report(raw);
  });
}).listen(PORT, () => {
  console.log(`listening on http://localhost:${PORT} → ${OUT}`);
  console.log(`expose it:  cloudflared tunnel --url http://localhost:${PORT}`);
});

function report(raw) {
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    // Form-encoded means an AIO CheckMacValue notify hit the wrong endpoint.
    console.log("   not JSON — raw body follows:");
    console.log(raw);
    return;
  }

  console.log(
    `   envelope: ${JSON.stringify({ ...envelope, Data: `<${envelope.Data?.length ?? 0} chars>` })}`,
  );
  if (!envelope.Data) {
    console.log("   no Data field to decrypt");
    return;
  }
  try {
    console.log(JSON.stringify(decryptData(envelope.Data, HASH_KEY, HASH_IV), null, 2));
  } catch (err) {
    console.log(`   decrypt failed (wrong HashKey/HashIV?): ${err.message}`);
  }
}
