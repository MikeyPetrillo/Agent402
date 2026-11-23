// The buyer-facing rule for AWS Marketplace paid calls that end without an
// answer, printed word for word by /aws/start (src/aws-start-page.js) and
// /terms (src/terms.js), and kept true by src/aws-unanswered.js: every such
// attempt is recorded at once with whether the payment can still be retried.
// Its own module so the terms date pin (scripts/test-legal-dates.js) hashes
// this text and not the record's code.
export const AWS_UNANSWERED_SENTENCE = "Every paid call that ends without an answer is recorded with its payment id, the tool, the time, why it ended and whether the payment can still be retried; one that is not answered on a later attempt is reviewed, and an approved correction is made as a billing adjustment on your AWS invoice through AWS Marketplace.";
