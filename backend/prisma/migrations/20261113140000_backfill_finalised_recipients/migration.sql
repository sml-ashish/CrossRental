-- Rows already past the point the new status describes: the RFQ was closed by an
-- award and this vendor never quoted. Backfilling them keeps the vendor inbox
-- honest for RFQs that were finalised before this change — otherwise they would
-- keep reading "Awaiting your quote" for ever.
--
-- Only PENDING rows on a CLOSED RFQ qualify. A vendor who quoted keeps QUOTED
-- (their quotation carries the Not Awarded outcome), and DECLINED / EXPIRED
-- rows already say what happened.
UPDATE "rfq_vendor_recipients" AS r
SET "responseStatus" = 'FINALISED'
FROM "rfqs" AS f
WHERE r."rfqId" = f."id"
  AND f."status" = 'CLOSED'
  AND r."responseStatus" = 'PENDING';
