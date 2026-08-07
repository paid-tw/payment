import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import {
  buildQuery,
  checkCode,
  checkValue,
  decryptTradeInfo,
  encryptTradeInfo,
  tradeSha,
} from "../crypto.js";

/**
 * Golden vectors, copied character-for-character from:
 * - the NDNF-1.2.3 manual (MPG 幕前支付) worked examples — sandbox credentials
 *   printed in the manual itself (public documentation values, not secrets);
 * - the NDNP-1.0.7 manual (定期定額) worked examples — its own sandbox shop;
 * - onlinemad/node-newebpay's test suite (matches older official manuals).
 *
 * Known-bad manual vectors deliberately NOT tested: the EWallet (NPA-B06)
 * request/response and BNPL settle (NPA-B62) examples were produced under a
 * different shop's HashKey/HashIV and can never recompute (verified: their
 * first AES block differs despite an identical plaintext prefix). Do not "fix"
 * the implementation to match them.
 */

// NDNF-1.2.3 sandbox shop (printed in the manual).
const KEY = "Fs5cX1TGqYM2PpdbE14a9H83YQSQF5jn";
const IV = "C6AcmfqJILwgnhIP";

// Manual pp.18–21 — MPG request TradeInfo/TradeSha.
const MPG = {
  plaintext:
    "MerchantID=MS127874575&RespondType=String&TimeStamp=1695795410&Version=2.0&MerchantOrderNo=Vanespl_ec_1695795410&Amt=30&ItemDesc=test&NotifyURL=https%3A%2F%2Fwebhook.site%2Fd4db5ad1-2278-466a-9d66-78585c0dbadb",
  hex: "f79eac33c4f3245d58f17b544c5d38b09457a6d77e77bae6f10fcc7236fe153ccef1a80001c0746afc063a7570f80ad970d8a32c72332c9ec5547410188007876bdca2bafa52d07d31b6b183f2204d6e4feee6d245e286ab198cf95422ad5843c7696fc943cbb65979ad207607d4b5d97dac4a90ccd5e7a37adb7d7062e838be09d94e8c5dfa145c048e17feabe58c2e310792f0f50f5af32961ffb07ff6649ae1021ad558242551de5f09316e3182e198775e5d1ad5b66a70be290004de750fa85d86b0c2f087b40005d89e048be2ab6fd83f1c522494c093426a10a1f73fe4",
  sha: "84E4D9F96537E029F8450BE1E759080F9AF6995921B7F6F9AAFDDD2C36E7B287",
};

// Manual pp.23/25 — a notify body PRODUCED BY THE GATEWAY (not by sample code),
// so it also proves the gateway's own padding is compatible with ours.
const NOTIFY = {
  hex: "ee11d1501e6dc8433c75988258f2343d11f4d0a423be672e8e02aaf373c53c2363aeffdb4992579693277359b3e449ebe644d2075fdfbc10150b1c40e7d24cb215febefdb85b16a5cde449f6b06c58a5510d31e8d34c95284d459ae4b52afc1509c2800976a5c0b99ef24cfd28a2dfc8004215a0c98a1d3c77707773c2f2132f9a9a4ce3475cb888c2ad372485971876f8e2fec0589927544c3463d30c785c2d3bd947c06c8c33cf43e131f57939e1f7e3b3d8c3f08a84f34ef1a67a08efe177f1e663ecc6bedc7f82640a1ced807b548633cfa72d060864271ec79854ee2f5a170aa902000e7c61d1269165de330fce7d10663d1668c711571776365bfdcd7ddc915dcb90d31a9f27af9b79a443ca8302e508b0dbaac817d44cfc44247ae613075dde4ac960f1bdff4173b915e4344bc4567bd32e86be7d796e6d9b9cf20476e4996e98ccc315f1ed03a34139f936797d971f2a3f90bc18f8a155a290bcbcf04f4277171c305bf554f5cba243154b30082748a81f2e5aa432ef9950cc9668cd4330ef7c37537a6dcb5e6ef01b4eca9705e4b097cf6913ee96e81d0389e5f775",
  sha: "C80876AEBAC0036268C0E240E5BFF69C0470DE9606EEE083C5C8DD64FDB3347A",
  plaintext:
    "Status=SUCCESS&Message=%E6%8E%88%E6%AC%8A%E6%88%90%E5%8A%9F&MerchantID=MS127874575&Amt=30&TradeNo=23092714215835071&MerchantOrderNo=Vanespl_ec_1695795668&RespondType=String&IP=123.51.237.115&EscrowBank=HNCB&PaymentType=CREDIT&RespondCode=00&Auth=115468&Card6No=400022&Card4No=1111&Exp=2609&AuthBank=KGI&TokenUseStatus=0&InstFirst=0&InstEach=0&Inst=0&ECI=&PayTime=2023-09-27+14%3A21%3A59&PaymentMethod=CREDIT",
};

// Manual pp.80–81 — BNPL refund EncryptData_/HashData_. THE padding-deciding
// vector: plaintext 131 B → ciphertext 144 B is exactly PKCS7-16 output
// (pad-to-32 would give 160 B and a different tail).
const BNPL_REFUND = {
  plaintext:
    "MerchantOrderNo=20260319171325Er3u3wjLo0&Amt=100&TimeStamp=1773911850&PaymentType=AFTEE&Reason=%E4%B8%80%E8%88%AC%E9%80%80%E8%B2%A8",
  hex: "e2408ccc889430c76e57720ab3e4ad265e87ef6166ae7525572533aca9044cbe990f6ab66c820bccb53679ba7f880d06389700009a124a62441d1f090fd3c64def6b85f72b656b6fb013a7fa37386f3e006d3c2842e5e6559e7addd3737ea63fb240bb772e578ece5582c7915e20c1a291289d2ebb6f67dbb25345da9d1d554788e1a23affce9015c156bf4924c1b6d8",
  sha: "F7BAC61306FF1B1F8F4B27B2741CB8071887357C858D42EBC601B592AE6E1F05",
};

// Manual p.61 — QueryTradeInfo response for the sandbox shop, real CheckCode.
const QUERY_CHECKCODE = {
  fields: {
    Amt: 30,
    MerchantID: "MS127874575",
    MerchantOrderNo: "Vanespl_ec_1695795668",
    TradeNo: "23092714215835071",
  },
  expected: "79C5227AF869AE4F25FDF4E22B928D5B52E415D9905EC6912D7807E18C3FFACA",
};

// NDNP-1.0.7 sandbox shop (printed in the periodic manual).
const P_KEY = "IaWudQJsuOT994cpHRWzv7Ge67yC1cE3";
const P_IV = "C1dLm3nxZRVlmBSP";

// NDNP §4.2 — create-mandate PostData_ request vector.
const PERIOD_CREATE = {
  plaintext:
    "RespondType=JSON&TimeStamp=1700033460&Version=1.5&LangType=zh-Tw&MerOrderNo=myorder1700033460&ProdDesc=Test+commssion&PeriodAmt=10&PeriodType=M&PeriodPoint=05&PeriodStartType=2&PeriodTimes=12&PayerEmail=test%40neweb.com.tw&PaymentInfo=Y&OrderInfo=N&EmailModify=1&NotifyURL=https%3A%2F%2Fwebhook.site%2Fb728e917-1bf7-478b-b0f9-73b56aeb44e0",
  hex: "45d5175feaa9ef2ea039f84afba34c6330e8fa21ae01ec40f15ab00073b4e93584cc1d3a7e2b26feb08216d14074dd4a83a64791e114cd15e200a88ef38720e7830d892953a25b84411abc8d0f86ff73719af52e0c303de9586c422702e806e599ffd739086b0c3f8c3b995b2a6ba92902070f5f8c4c2916f72b0d9c1027ca050799a6a55e78ff07c663e4b90aa3a84dfde353f1354fc5165ccc897f5ee0586a2852e2e5e1be1f3fa2f7a618377abdab9b6aa3af39eb005e461aaa2c8da4d2fd3af93bed9eb3438b01804a9a1bc39bcb6f7bd3a35bd275fe53923960bd76c4def1175e8b1f60acb21cd4ebe9c03fe10df2c1a6aa455e21899c02cba501ce2fb87c72a6cbb2a146ddd4688fd3ce9cf068bdb6f4f2c4351d78973d32268737e931def628d0f3f3aac038cd551a0f8c85e0d194542da74f6ba841c4068bab0f14453dbac0d16dba1de2656368238855dc6351821380a3455532a2259c2c5caf4cac",
};

// NDNP §4.3.2 — AlterStatus response `period` blob → suspend-success JSON.
const PERIOD_ALTER_STATUS_RESP = {
  hex: "e88f62186b6d5dd96a9f6dbc57a84547957e8cb8534d81cbed42dcffa93783a32940ba6716e1ebb85f3d92fbcf0497897d312c0181e878b2d1be5cafe7d7c2f81ab3327ed1b4529ced6c5c4c6d07c52e9943e9ec8f0735e8c9329c23789e3927e540f8f2a56517ddf37d6ee7196d41e0139d173616ccf964b40764109f8647851cf17a5eb3d75eb0fe017d45790e528528c59adfe84cf2518dbf7cf71776bed9768ca6a74103332dbfb7d0356fbeb230d9bcda35763ca6eaaad51033ab6f35195780ea6ac3f584adc78940e9a053858b657461a94a20942fd559f54f9843433a",
  status: "SUCCESS",
  result: {
    MerOrderNo: "myorder1700033460",
    PeriodNo: "P231115153213aMDNWZ",
    AlterType: "suspend",
  },
};

// onlinemad/node-newebpay test suite (matches older official manuals).
const OSS = {
  key: "12345678901234567890123456789012",
  iv: "1234567890123456",
  plaintext:
    "MerchantID=3430112&RespondType=JSON&TimeStamp=1485232229&Version=1.4&MerchantOrderNo=S_1485232229&Amt=40&ItemDesc=UnitTest",
  hex: "ff91c8aa01379e4de621a44e5f11f72e4d25bdb1a18242db6cef9ef07d80b0165e476fd1d9acaa53170272c82d122961e1a0700a7427cfa1cf90db7f6d6593bbc93102a4d4b9b66d9974c13c31a7ab4bba1d4e0790f0cbbbd7ad64c6d3c8012a601ceaa808bff70f94a8efa5a4f984b9d41304ffd879612177c622f75f4214fa",
  sha: "EA0A6CC37F40C1EA5692E7CBB8AE097653DF3E91365E6A9CD7E91312413C7BB8",
};

const OSS_CHECKVALUE = {
  key: "abcdefg",
  iv: "1234567",
  fields: { MerchantOrderNo: "840f022", MerchantID: "1422967", Amt: 100 },
  expected: "379BF1DB8948EE79D8ED77A1EBCB2F57B0FD45D0376B6DA9CF85F539CEF1C127",
};

const OSS_CHECKCODE = {
  key: "abcdefg",
  iv: "1234567",
  fields: { MerchantOrderNo: "840f022", MerchantID: "1422967", Amt: 100, TradeNo: "14061313541640927" },
  expected: "62C687AF6409E46E79769FAF54F54FE7E75AAE50BAF0767752A5C337670B8EDB",
};

// Exercises PHP form-encoding inside the hash input: space → '+', ':' → %3A.
const OSS_CHECKCODE_ENC = {
  key: "abcdefg",
  iv: "1234567",
  fields: {
    MerchantID: "ABC1422967",
    Date: "2015-01-01 00:00:00",
    UseInfo: "ON",
    CreditInst: "ON",
    CreditRed: "ON",
  },
  expected: "77A1EF8F23C94CB63A60A7EDF99AC3E0F4688D96AF6D4B34370D306ABD33D0F6",
};

/** Legacy pad-to-32 encryption (official PHP sample style, used by most OSS SDKs). */
function encryptPad32(plaintext: string, hashKey: string, hashIv: string): string {
  const buf = Buffer.from(plaintext, "utf8");
  const pad = 32 - (buf.length % 32);
  const padded = Buffer.concat([buf, Buffer.alloc(pad, pad)]);
  const cipher = crypto.createCipheriv(
    "aes-256-cbc",
    Buffer.from(hashKey, "utf8"),
    Buffer.from(hashIv, "utf8"),
  );
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("hex");
}

describe("encryptTradeInfo — golden ciphertexts", () => {
  it("reproduces the manual's MPG request vector", () => {
    expect(encryptTradeInfo(MPG.plaintext, KEY, IV)).toBe(MPG.hex);
  });

  it("reproduces the manual's BNPL refund vector (the padding-deciding one)", () => {
    expect(encryptTradeInfo(BNPL_REFUND.plaintext, KEY, IV)).toBe(BNPL_REFUND.hex);
  });

  it("reproduces the periodic manual's create-mandate PostData_ vector", () => {
    expect(encryptTradeInfo(PERIOD_CREATE.plaintext, P_KEY, P_IV)).toBe(PERIOD_CREATE.hex);
  });

  it("reproduces the OSS MPG vector", () => {
    expect(encryptTradeInfo(OSS.plaintext, OSS.key, OSS.iv)).toBe(OSS.hex);
  });

  it("rejects wrong-length HashKey / HashIV", () => {
    expect(() => encryptTradeInfo("x", "short", IV)).toThrow(/32 bytes/);
    expect(() => encryptTradeInfo("x", KEY, "short")).toThrow(/16 bytes/);
  });
});

describe("tradeSha — golden digests", () => {
  it("reproduces the manual's MPG TradeSha", () => {
    expect(tradeSha(MPG.hex, KEY, IV)).toBe(MPG.sha);
  });

  it("reproduces the gateway-produced notify TradeSha", () => {
    expect(tradeSha(NOTIFY.hex, KEY, IV)).toBe(NOTIFY.sha);
  });

  it("reproduces the manual's BNPL refund HashData_", () => {
    expect(tradeSha(BNPL_REFUND.hex, KEY, IV)).toBe(BNPL_REFUND.sha);
  });

  it("reproduces the OSS TradeSha", () => {
    expect(tradeSha(OSS.hex, OSS.key, OSS.iv)).toBe(OSS.sha);
  });
});

describe("decryptTradeInfo — golden plaintexts", () => {
  it("recovers the manual's MPG plaintext", () => {
    expect(decryptTradeInfo(MPG.hex, KEY, IV)).toBe(MPG.plaintext);
  });

  it("recovers the gateway-produced notify plaintext", () => {
    expect(decryptTradeInfo(NOTIFY.hex, KEY, IV)).toBe(NOTIFY.plaintext);
  });

  it("recovers the BNPL refund plaintext", () => {
    expect(decryptTradeInfo(BNPL_REFUND.hex, KEY, IV)).toBe(BNPL_REFUND.plaintext);
  });

  it("recovers the periodic create-mandate plaintext", () => {
    expect(decryptTradeInfo(PERIOD_CREATE.hex, P_KEY, P_IV)).toBe(PERIOD_CREATE.plaintext);
  });

  it("decrypts the periodic AlterStatus response into the documented JSON", () => {
    const parsed = JSON.parse(decryptTradeInfo(PERIOD_ALTER_STATUS_RESP.hex, P_KEY, P_IV)) as {
      Status: string;
      Result: Record<string, string>;
    };
    expect(parsed.Status).toBe(PERIOD_ALTER_STATUS_RESP.status);
    expect(parsed.Result).toMatchObject(PERIOD_ALTER_STATUS_RESP.result);
  });

  it("strips legacy pad-to-32 ciphertexts (pad bytes 0x11–0x20)", () => {
    // 16-byte plaintext → pad-32 emits a full 0x10-padded block a strict PKCS7
    // unpadder would reject; length 20 → pad byte 0x1c, same story.
    for (const plaintext of ["abcdefghijklmnop", "20-char-plaintext-xx"]) {
      const hex = encryptPad32(plaintext, KEY, IV);
      expect(decryptTradeInfo(hex, KEY, IV)).toBe(plaintext);
    }
  });

  it("rejects ciphertext produced under a different HashKey/HashIV", () => {
    const foreign = encryptTradeInfo("Status=SUCCESS", OSS.key, OSS.iv);
    expect(() => decryptTradeInfo(foreign, KEY, IV)).toThrow(/padding/);
  });

  it("rejects corrupt padding", () => {
    // Valid last-byte value but inconsistent pad run.
    const block = Buffer.alloc(16, 0x41);
    block[15] = 3; // claims 3 pad bytes, but bytes 13–14 are 0x41
    const cipher = crypto.createCipheriv(
      "aes-256-cbc",
      Buffer.from(KEY, "utf8"),
      Buffer.from(IV, "utf8"),
    );
    cipher.setAutoPadding(false);
    const hex = Buffer.concat([cipher.update(block), cipher.final()]).toString("hex");
    expect(() => decryptTradeInfo(hex, KEY, IV)).toThrow(/corrupt/);
  });

  it("round-trips UTF-8 multibyte content", () => {
    const plaintext = "ItemDesc=測試商品 一般退貨&Amt=100";
    expect(decryptTradeInfo(encryptTradeInfo(plaintext, KEY, IV), KEY, IV)).toBe(plaintext);
  });
});

describe("checkValue — QueryTradeInfo request", () => {
  it("reproduces the OSS golden vector", () => {
    expect(checkValue(OSS_CHECKVALUE.fields, OSS_CHECKVALUE.key, OSS_CHECKVALUE.iv)).toBe(
      OSS_CHECKVALUE.expected,
    );
  });
});

describe("checkCode — Query/Cancel responses", () => {
  it("reproduces the manual p.61 query-response CheckCode", () => {
    expect(checkCode(QUERY_CHECKCODE.fields, KEY, IV)).toBe(QUERY_CHECKCODE.expected);
  });

  it("reproduces the OSS golden vector", () => {
    expect(checkCode(OSS_CHECKCODE.fields, OSS_CHECKCODE.key, OSS_CHECKCODE.iv)).toBe(
      OSS_CHECKCODE.expected,
    );
  });

  it("reproduces the OSS encoding vector (space → '+', ':' → %3A)", () => {
    expect(checkCode(OSS_CHECKCODE_ENC.fields, OSS_CHECKCODE_ENC.key, OSS_CHECKCODE_ENC.iv)).toBe(
      OSS_CHECKCODE_ENC.expected,
    );
  });
});

describe("buildQuery — http_build_query parity", () => {
  it("preserves field order, drops undefined, PHP-encodes values", () => {
    expect(
      buildQuery({
        MerchantID: "MS127874575",
        NotifyURL: "https://example.com/n?a=1",
        ItemDesc: "測試 商品~!",
        Skip: undefined,
        Amt: 30,
      }),
    ).toBe(
      "MerchantID=MS127874575&NotifyURL=https%3A%2F%2Fexample.com%2Fn%3Fa%3D1&ItemDesc=%E6%B8%AC%E8%A9%A6+%E5%95%86%E5%93%81%7E%21&Amt=30",
    );
  });
});
