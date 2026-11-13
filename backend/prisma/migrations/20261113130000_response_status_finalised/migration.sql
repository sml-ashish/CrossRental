-- AlterEnum
-- The recipient's terminal state when the RFQ is finalised without a quote from
-- them (another vendor was awarded). Kept in its own migration because Postgres
-- cannot use a value added to an enum in the same transaction that adds it.
ALTER TYPE "ResponseStatus" ADD VALUE 'FINALISED';
