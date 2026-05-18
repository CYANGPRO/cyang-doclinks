import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "cyang.io Doclinks";
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          height: "100%",
          width: "100%",
          background:
            "radial-gradient(circle at top left, rgba(74, 121, 194, 0.22), transparent 32%), radial-gradient(circle at right, rgba(157, 125, 67, 0.16), transparent 30%), linear-gradient(180deg, #fbfcfe 0%, #eef3f8 100%)",
          color: "#0f1720",
          padding: "56px",
          fontFamily: "Avenir Next, Segoe UI, sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            width: "100%",
            border: "1px solid rgba(15, 23, 32, 0.08)",
            background: "rgba(255,255,255,0.86)",
            boxShadow: "0 24px 60px rgba(19, 35, 53, 0.1)",
            padding: "56px",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: "100%" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "18px", fontSize: 22, letterSpacing: "0.22em", textTransform: "uppercase", color: "#627181" }}>
              <div style={{ width: 60, height: 60, border: "1px solid rgba(15,23,32,0.08)", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, fontWeight: 700 }}>
                CY
              </div>
              Doclinks by cyang.io
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "16px", maxWidth: 840 }}>
              <div style={{ fontSize: 78, lineHeight: 0.95, letterSpacing: "-0.05em", fontWeight: 700 }}>
                Send private documents
              </div>
              <div style={{ fontSize: 78, lineHeight: 0.95, letterSpacing: "-0.05em", fontWeight: 700, color: "#627181" }}>
                without losing control.
              </div>
              <div style={{ fontSize: 28, lineHeight: 1.4, color: "#334254" }}>
                Protected links, recipient-friendly delivery, and sender controls that still matter after send.
              </div>
            </div>
            <div style={{ display: "flex", gap: "28px", fontSize: 24, color: "#334254" }}>
              <div>Protected links</div>
              <div>Expiry and revocation</div>
              <div>Trust surfaces included</div>
            </div>
          </div>
        </div>
      </div>
    ),
    size
  );
}
