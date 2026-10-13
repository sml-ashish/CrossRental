-- Duplicate detection (brief 6.2): reject a new crane when the same vendor
-- already has an ACTIVE crane with the same serial/registration number.
--
-- Prisma cannot express a partial unique index, and a plain composite
-- unique on (vendor_id, serial_registration_no) would be wrong: a vendor
-- who soft-deactivates a crane must still be able to re-enter the same
-- serial number later. So the constraint is created here in raw SQL.
CREATE UNIQUE INDEX "cranes_vendor_serial_active_uniq"
  ON "cranes" ("vendorId", "serialRegistrationNo")
  WHERE "isActive" = true;

-- Enforces the India bounding box from brief 5.2 (lat 6-38, lng 68-98).
-- Geocoding and manual pin drops are both validated in application code so
-- the vendor gets a friendly message, but this is the backstop that keeps a
-- provider bug from writing coordinates into another country.
ALTER TABLE "cranes"
  ADD CONSTRAINT "cranes_coords_in_india_chk"
  CHECK (
    ("latitude" IS NULL AND "longitude" IS NULL)
    OR (
      "latitude" BETWEEN 6 AND 38
      AND "longitude" BETWEEN 68 AND 98
    )
  );

ALTER TABLE "rfqs"
  ADD CONSTRAINT "rfqs_site_coords_in_india_chk"
  CHECK (
    ("siteLatitude" IS NULL AND "siteLongitude" IS NULL)
    OR (
      "siteLatitude" BETWEEN 6 AND 38
      AND "siteLongitude" BETWEEN 68 AND 98
    )
  );

-- Arithmetic guards (brief 6.7). Application code validates these too, but
-- the portal writes money figures and should never rely on validation alone.
ALTER TABLE "quotations"
  ADD CONSTRAINT "quotations_rental_rate_positive_chk" CHECK ("rentalRate" > 0);
ALTER TABLE "quotations"
  ADD CONSTRAINT "quotations_mobilisation_non_negative_chk" CHECK ("mobilisationCharges" >= 0);

ALTER TABLE "rfqs"
  ADD CONSTRAINT "rfqs_quantity_positive_chk" CHECK ("quantity" > 0);
ALTER TABLE "rfqs"
  ADD CONSTRAINT "rfqs_duration_positive_chk" CHECK ("durationValue" > 0);

ALTER TABLE "cranes"
  ADD CONSTRAINT "cranes_capacity_positive_chk" CHECK ("capacityT" > 0);
ALTER TABLE "cranes"
  ADD CONSTRAINT "cranes_yom_not_future_chk"
  CHECK ("yom" >= 1950 AND "yom" <= EXTRACT(YEAR FROM CURRENT_DATE)::int);