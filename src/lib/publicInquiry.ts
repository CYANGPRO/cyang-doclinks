export const INQUIRY_TOPICS = [
  "demo_request",
  "procurement",
  "product_support",
  "privacy_legal",
  "security_disclosure",
  "general",
] as const;

export type InquiryTopic = (typeof INQUIRY_TOPICS)[number];

export const INQUIRY_TOPIC_LABELS: Record<InquiryTopic, string> = {
  demo_request: "Demo request",
  procurement: "Procurement review",
  product_support: "Product support",
  privacy_legal: "Privacy or legal",
  security_disclosure: "Security disclosure",
  general: "General inquiry",
};

export function normalizeInquiryTopic(value: unknown): InquiryTopic | null {
  const normalized = String(value || "").trim().toLowerCase();
  return INQUIRY_TOPICS.find((topic) => topic === normalized) ?? null;
}
