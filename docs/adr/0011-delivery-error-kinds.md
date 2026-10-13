# 0011: Closed delivery error kinds

`errorKind` on delivery rows and send outcomes is a closed union, `DELIVERY_ERROR_KINDS`, validated by `deliveryErrorKindValidator` and typed `DeliveryErrorKind`. An open string let a renamed or misspelled kind reach stored rows and application branches unnoticed; a closed union makes the schema reject an unlisted kind and lets applications switch exhaustively. Each value is documented in README Concepts. Adding a kind changes the public schema and requires amending this record.

Payload preparation maps package errors to kinds explicitly: `WEB_PUSH_PAYLOAD_TOO_LARGE` to `payload_too_large`, `WEB_PUSH_INVALID_ARGUMENT` to `invalid_subscription_keys`, and any other package error to `crypto_unsupported`.
