import type { PaymentErrorCode } from "@paid-tw/payment";

/**
 * LINE Pay result codes → zh-TW messages, verbatim from the Online API v4
 * 結果程式碼 table (developers-pay.line.me/zh/online-api-v4#result-code,
 * fetched 2026-08-13). `0000`/`01XX` are payment-request **statuses**, not
 * errors — they are included so any returnCode resolves to a message.
 *
 * The table prints temporary errors as the literal row `190X`;
 * {@link linepayErrorMessage} expands that prefix.
 */
export const LINEPAY_RESULT_MESSAGES: Record<string, string> = {
  "0000": "請求成功執行（查詢付款請求狀態時＝顧客完成認證前）",
  "0110": "顧客已完成 LINE Pay 認證，可進行付款授權",
  "0121": "顧客取消付款或超過認證等待時間",
  "0122": "付款失敗",
  "0123": "付款完成",
  "1101": "該用戶不是 LINE Pay 用戶",
  "1102": "該用戶目前無法使用 LINE Pay 交易",
  "1104": "商店尚未註冊為合作商店或 credentials 錯誤",
  "1105": "該合作商店目前無法使用 LINE Pay",
  "1106": "請求標頭訊息有錯誤",
  "1110": "該信用卡無法正常使用",
  "1124": "金額訊息有誤",
  "1141": "帳戶狀態有問題",
  "1142": "餘額不足",
  "1145": "付款進行中",
  "1150": "無交易歷史",
  "1152": "有相同交易歷史",
  "1153": "付款請求金額和請款金額不同",
  "1154": "無法使用預先授權付款方式",
  "1155": "交易 ID 有誤",
  "1159": "無付款請求訊息",
  "1163": "無法退款（超過可退款期限）",
  "1164": "超出可退款金額",
  "1165": "已退款的交易",
  "1169": "須在 LINE Pay 中選擇付款方式並驗證認證密碼",
  "1170": "會員帳戶餘額發生變化",
  "1172": "已存在相同訂單號碼的交易記錄",
  "1177": "超出可查看的最多交易數量（100 筆）",
  "1178": "合作商店不支援該貨幣",
  "1179": "無法處理該狀態",
  "1180": "已超過付款期限",
  "1183": "付款金額必須大於設定的最低金額",
  "1184": "付款金額必須小於設定的最高金額",
  "1190": "無預先授權付款密鑰",
  "1193": "預先授權付款密鑰已逾期",
  "1194": "合作商店不支援預先授權付款",
  "1198": "API 呼叫請求重複",
  "1199": "內部請求發生錯誤",
  "1280": "信用卡付款時發生臨時錯誤",
  "1281": "信用卡付款時發生錯誤",
  "1282": "信用卡授權時發生錯誤",
  "1283": "有不當使用疑慮，付款被拒絕",
  "1284": "信用卡付款暫時暫停",
  "1285": "信用卡付款訊息缺失",
  "1286": "信用卡付款訊息中有錯誤訊息",
  "1287": "信用卡已過期",
  "1288": "信用卡帳戶餘額不足",
  "1289": "超出信用卡額度",
  "1290": "超出信用卡單筆付款額度",
  "1291": "該卡已被通報失竊",
  "1292": "該卡已停用",
  "1293": "CVN 輸入錯誤",
  "1294": "該卡已被列入黑名單",
  "1295": "信用卡號碼錯誤",
  "1296": "無法處理此金額",
  "1298": "該卡被拒絕",
  "2042": "商家退款準備金不足，未能為該 EPI 交易進行退款",
  "2101": "參數錯誤",
  "2102": "JSON 數據格式錯誤",
  "9000": "發生了內部錯誤",
};

const AUTH_CODES = new Set([
  "1104", // not a registered merchant / bad credentials
  "1105", // merchant may not use LINE Pay
  "1106", // header error — bad signature/nonce/channel id
]);

const NOT_FOUND_CODES = new Set([
  "1150", // no transaction history
  "1155", // wrong transaction id
  "1159", // no payment-request info
  "1190", // no preapproved-payment regKey
]);

const CONFLICT_CODES = new Set([
  "1145", // payment still in progress
  "1152", // same transaction already processed
  "1163", // refund window closed
  "1165", // already refunded
  "1170", // wallet balance changed between request and confirm
  "1172", // duplicate orderId
  "1179", // state cannot be processed (e.g. confirm before auth)
  "1180", // payment deadline passed
  "1193", // regKey expired
  "1198", // duplicate API call — the first one is still running
]);

const VALIDATION_CODES = new Set([
  "1124", // bad amount
  "1153", // amount differs from the requested amount
  "1164", // refund amount exceeds the refundable balance
  "1177", // more than 100 ids in a details query
  "1178", // currency not supported by the merchant
  "1183", // below the minimum amount
  "1184", // above the maximum amount
  "2101", // parameter error
  "2102", // malformed JSON
]);

/**
 * Map a LINE Pay returnCode onto a stable {@link PaymentErrorCode}. Anything
 * unmapped falls through to PROVIDER (wallet/card declines, 190X temporary
 * errors, 9000) — the raw code is always preserved on the PaymentError.
 */
export function mapLinepayErrorCode(raw: string): PaymentErrorCode {
  if (AUTH_CODES.has(raw)) return "AUTH";
  if (NOT_FOUND_CODES.has(raw)) return "NOT_FOUND";
  if (CONFLICT_CODES.has(raw)) return "CONFLICT";
  if (VALIDATION_CODES.has(raw)) return "VALIDATION";
  return "PROVIDER";
}

/** The documented message for a code, falling back to the gateway's own text. */
export function linepayErrorMessage(raw: string, fallback?: string): string {
  const known = LINEPAY_RESULT_MESSAGES[raw];
  if (known) return known;
  if (/^190\d$/.test(raw)) return "發生臨時錯誤，請稍後再試一次";
  return fallback ?? "未知錯誤";
}
