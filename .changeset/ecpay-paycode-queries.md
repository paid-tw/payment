---
"@paid-tw/payment-ecpay": minor
---

Complete the ECPay 非信用卡幕後取號 surface:

- `getCvsBarcode` (`QueryCVSBarcode`) converts a 超商代碼 into three barcode segments.
  Segments are **chain-specific** (verified against stage), and `chain` accepts only
  `Family` / `Hilife` / `iBon` — the `CVS` and `OK` values usable at 取號 time cannot
  be converted.
- `downloadTradeMedia` (`QueryTradeMedia`) downloads the 撥款對帳檔. This endpoint
  answers **CSV, not the AES envelope**, and every cell is Excel-armoured as
  `="value"` — use the new `parseTradeMediaCsv` export rather than splitting it by
  hand. The real file carries a 13th column (`金流處理費`) that ECPay's doc omits.
