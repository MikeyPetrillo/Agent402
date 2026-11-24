// The notices outside owners ask for beside their marks, with our independence
// stated in the same line. One place, so every page prints the same words.
//
// AWS's trademark guidelines ask for this notice beside the first or most
// prominent use of its marks: every page that names AWS or AgentCore in its
// title prints it under the H1.
export const AWS_MARK_NOTICE = "Amazon Web Services, AWS and Amazon Bedrock AgentCore are trademarks of Amazon.com, Inc. or its affiliates. Agent402 is not affiliated with or endorsed by AWS.";
// EDGAR is the SEC's registered mark: the SEC filing tool pages and the report
// pages built from filings print this under their title or in their note.
export const EDGAR_MARK_NOTICE = "EDGAR is a registered trademark of the U.S. Securities and Exchange Commission. Agent402 is not affiliated with or approved by the SEC.";
/** True for a tool whose page carries the EDGAR notice: the SEC filing tools. */
export const namesEdgar = (tool) => /^edgar-/.test(String(tool?.slug || ""));
// Anthropic's guidelines bar implied sponsorship: the Claude Managed Agents
// page prints this under its H1.
export const CLAUDE_MARK_NOTICE = "Claude and Claude Managed Agents are trademarks of Anthropic, PBC. Agent402 is not affiliated with or endorsed by Anthropic.";
