"use client";

import { useEffect, useState } from "react";
import { AlertBanner, SectionCard } from "@/components/DesignSystem";
import type { DocumentUploadVisibilityOption } from "@/components/DocumentUploadForm";
import { formatCatDate } from "@/lib/date-format";
import { isNativeMobile, Local801Native, type NativeDocument, type PendingShare } from "@/lib/native-mobile";

function safeRoute(value: string) {
  try {
    const url = new URL(value);
    if (url.origin !== "https://cat.cyang.io" || url.username || url.password || url.hash) return null;
    return `${url.pathname}${url.search}`;
  } catch { return null; }
}

export function MobileDocumentIntake({ visibilityOptions }: { visibilityOptions: readonly DocumentUploadVisibilityOption[] }) {
  const [document, setDocument] = useState<NativeDocument | PendingShare | null>(null);
  const [native, setNative] = useState(false);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("Field intake");
  const [visibility, setVisibility] = useState(visibilityOptions[0]?.value ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isNativeMobile()) return;
    void Local801Native.getCapabilities().then(() => {
      setNative(true);
      return Local801Native.getPendingShare();
    }).then((shared) => {
      if (shared.source === "share") {
        setDocument(shared);
        setTitle(shared.name.replace(/\.pdf$/i, "").slice(0, 255));
        setMessage("A shared document is ready for review. Nothing is uploaded until you confirm below.");
      }
    }).catch(() => undefined);
  }, []);

  if (!native) return null;

  async function scanDocument() {
    setBusy(true); setMessage(null);
    try {
      const scanned = await Local801Native.scanDocument();
      setDocument(scanned); setTitle(`Scanned document ${formatCatDate(new Date())}`);
      setMessage("The scan is held only for this secure upload. Confirm its title and sharing scope.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "The document scanner could not start."); }
    finally { setBusy(false); }
  }

  async function scanCode() {
    setBusy(true); setMessage(null);
    try {
      const scanned = await Local801Native.scanCode();
      const route = safeRoute(scanned.value);
      if (!route) throw new Error("Only verified cat.cyang.io QR links can open in this application.");
      window.location.assign(route);
    } catch (error) { setMessage(error instanceof Error ? error.message : "The QR code could not be read."); setBusy(false); }
  }

  async function queueUpload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!document) { setMessage("Scan or share a PDF first."); return; }
    setBusy(true); setMessage(null);
    try {
      await Local801Native.queueBackgroundUpload({
        base64Data: document.base64Data,
        name: document.name,
        mediaType: document.mediaType,
        title,
        category,
        visibility,
      });
      setDocument(null); setTitle("");
      setMessage("The encrypted upload is queued. The temporary device copy will be deleted after upload or terminal failure.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "The secure background upload could not be queued."); }
    finally { setBusy(false); }
  }

  return <SectionCard
    title="Mobile intake"
    description="Scan paper, open a trusted Local 801 QR link, or share a PDF into the signed app for immediate encrypted upload."
  >
    <AlertBanner title="No protected offline library">
      Capture files are transient, encrypted with the device keystore, excluded from backups, and deleted after upload. The app never downloads or caches member records for offline use.
    </AlertBanner>
    <div className="page-actions">
      <button className="button" type="button" disabled={busy} onClick={() => void scanDocument()}>{busy ? "Opening…" : "Scan document"}</button>
      <button className="button secondary" type="button" disabled={busy} onClick={() => void scanCode()}>Scan trusted QR link</button>
    </div>
    {document ? <form className="stack" onSubmit={queueUpload}>
      <p><strong>Ready:</strong> {document.name}</p>
      <div className="form-grid">
        <div className="field"><label htmlFor="mobile-document-title">Title</label><input id="mobile-document-title" value={title} maxLength={255} required onChange={(event) => setTitle(event.currentTarget.value)} /></div>
        <div className="field"><label htmlFor="mobile-document-category">Category</label><input id="mobile-document-category" value={category} maxLength={100} required onChange={(event) => setCategory(event.currentTarget.value)} /></div>
        <div className="field"><label htmlFor="mobile-document-visibility">Who can view it</label><select id="mobile-document-visibility" value={visibility} required onChange={(event) => setVisibility(event.currentTarget.value)}>{visibilityOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
      </div>
      <div className="form-actions">
        <button className="button" type="submit" disabled={busy || !title.trim() || !category.trim() || !visibility}>{busy ? "Encrypting…" : "Queue secure upload"}</button>
        <button className="button secondary" type="button" disabled={busy} onClick={() => { setDocument(null); setMessage("The temporary capture was discarded."); }}>Discard</button>
      </div>
    </form> : null}
    {message ? <p className="form-message" role="status">{message}</p> : null}
  </SectionCard>;
}

export const __testing = { safeRoute };
