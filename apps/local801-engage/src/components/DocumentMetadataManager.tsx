"use client";

import { type FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

type Relationship = { handle: string; relationship_type: string; target_kind: string; target_handle: string; target_label: string };
type Target = { kind: "document" | "campaign" | "cat_action"; handle: string; label: string };

async function change(url: string, method: "PATCH" | "DELETE", body?: Record<string, unknown>) {
  const response = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(payload.message || "The document metadata could not be changed.");
}

export function DocumentMetadataManager({ documentHandle, tags, relationships, targets }: { documentHandle: string; tags: string[]; relationships: Relationship[]; targets: Target[] }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  async function saveTags(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget;
    const values = String(new FormData(form).get("tags") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
    setPending(true); setMessage("");
    try { await change(`/api/documents/${documentHandle}/metadata`, "PATCH", { action: "set_tags", tags: values }); setMessage("Tags saved."); router.refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Tags could not be saved."); }
    finally { setPending(false); }
  }
  async function addRelationship(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    const [targetKind, targetHandle] = String(data.get("target") ?? "").split(":", 2);
    setPending(true); setMessage("");
    try { await change(`/api/documents/${documentHandle}/metadata`, "PATCH", { action: "add_relationship", targetKind, targetHandle, relationshipType: String(data.get("relationshipType") ?? "related") }); form.reset(); setMessage("Relationship added."); router.refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "CAT couldn’t link the record."); }
    finally { setPending(false); }
  }
  async function remove(handle: string) {
    setPending(true); setMessage("");
    try { await change(`/api/document-relationships/${handle}`, "DELETE"); setMessage("Relationship removed."); router.refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "CAT couldn’t remove the link."); }
    finally { setPending(false); }
  }
  const kindLabel = (kind: string) => kind === "cat_action" ? "CAT Action" : kind[0]?.toUpperCase() + kind.slice(1);
  return <div className="grid">
    <form className="stack" onSubmit={saveTags}>
      <div className="field"><label htmlFor="document-tags">Tags</label><input id="document-tags" name="tags" maxLength={340} defaultValue={tags.join(", ")} placeholder="contract, training, campaign" /><span className="field-help">Up to eight comma-separated tags; 40 characters each.</span></div>
      <div className="form-actions"><button className="button" disabled={pending} type="submit">{pending ? "Saving…" : "Save tags"}</button></div>
    </form>
    <div><h3>Relationships</h3>{relationships.length ? <ul className="record-list">{relationships.map((item) => <li key={item.handle}><span><strong>{item.relationship_type}</strong> · {kindLabel(item.target_kind)} · {item.target_label}</span><button className="button secondary compact-button" disabled={pending} onClick={() => void remove(item.handle)} type="button">Remove</button></li>)}</ul> : <p className="muted">No relationships recorded.</p>}</div>
    {targets.length ? <form className="form-grid" onSubmit={addRelationship}>
      <div className="field"><label htmlFor="document-relationship-type">Relationship</label><select id="document-relationship-type" name="relationshipType" defaultValue="related"><option value="related">Related to</option><option value="supports">Supports</option><option value="reference">References</option><option value="supersedes">Supersedes</option></select></div>
      <div className="field"><label htmlFor="document-relationship-target">Target</label><select id="document-relationship-target" name="target" defaultValue="" required><option value="" disabled>Select a record</option>{targets.map((target) => <option key={`${target.kind}:${target.handle}`} value={`${target.kind}:${target.handle}`}>{kindLabel(target.kind)} · {target.label}</option>)}</select></div>
      <div className="form-actions"><button className="button" disabled={pending} type="submit">{pending ? "Saving…" : "Add relationship"}</button></div>
    </form> : null}
    {message ? <p className="form-message" role="status">{message}</p> : null}
  </div>;
}
