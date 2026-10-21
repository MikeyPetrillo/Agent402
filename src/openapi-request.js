// The request body a priced POST route publishes on /openapi.json, and the one
// reader every script uses to get it back.
//
// Most routes take JSON. A route whose discovery says bodyType "form-data"
// (the OpenAI transcription wire) takes multipart/form-data only, so its body
// is published under that media type: a buyer that follows the document sends
// what the route parses, and a JSON body there answers 400. The example keeps
// the route's discovery input, whose file part is a placeholder string naming
// the multipart part.
export const JSON_TYPE = "application/json";
export const MULTIPART_TYPE = "multipart/form-data";

/** True when a tool's discovery block declares a multipart body. */
export const isMultipartDiscovery = (discovery) => discovery?.bodyType === "form-data";

/** The OpenAPI requestBody for a POST tool from its discovery block. */
export function openapiRequestBody(discovery) {
  const props = discovery?.inputSchema?.properties ?? {};
  const required = discovery?.inputSchema?.required ?? [];
  const schema = { type: "object", properties: props, required: required.length ? required : undefined };
  const media = isMultipartDiscovery(discovery) ? MULTIPART_TYPE : JSON_TYPE;
  return { required: true, content: { [media]: { schema, example: discovery?.input ?? {} } } };
}

/** The request example an operation publishes and its media type, JSON first.
 *  `{ contentType, example, schema }`, or null when the operation has neither. */
export function requestExampleOf(op) {
  const content = op?.requestBody?.content;
  if (!content || typeof content !== "object") return null;
  for (const contentType of [JSON_TYPE, MULTIPART_TYPE]) {
    const media = content[contentType];
    if (media && typeof media === "object") return { contentType, example: media.example, schema: media.schema };
  }
  return null;
}

/** True when an operation's published body is multipart/form-data. */
export const isMultipartOperation = (op) => requestExampleOf(op)?.contentType === MULTIPART_TYPE;

/** A FormData body for a multipart example: the file bytes as the `file` part,
 *  every other scalar field of the example as a text part. */
export function multipartBodyFrom(fields, { bytes, type = "application/octet-stream", filename = "file" }) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), filename);
  for (const [k, v] of Object.entries(fields || {})) if (k !== "file" && v != null && typeof v !== "object") form.append(k, String(v));
  return form;
}
