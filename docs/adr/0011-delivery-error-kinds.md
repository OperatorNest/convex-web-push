# 0011: Closed delivery error kinds

`errorKind` on delivery rows and send outcomes is a closed union, `DELIVERY_ERROR_KINDS`, validated by `deliveryErrorKindValidator` and typed `DeliveryErrorKind`. An open string let a renamed or misspelled kind reach stored rows and application branches unnoticed; a closed union makes the schema reject an unlisted kind and lets applications switch exhaustively. Each value is documented in README Concepts. Adding a kind changes the public schema and requires amending this record. Version 0.2.0 stored an open string and wrote `crypto_error` and `invalid_subscription`, which the union rejects; no migration exists, so a 0.2.0 deployment deletes its component rows before upgrading.

Payload preparation maps package errors to kinds explicitly: `WEB_PUSH_PAYLOAD_TOO_LARGE` to `payload_too_large`, `WEB_PUSH_INVALID_ARGUMENT` to `invalid_subscription_keys`, and any other package error to `crypto_unsupported`.
