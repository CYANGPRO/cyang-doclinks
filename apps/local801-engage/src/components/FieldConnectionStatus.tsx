"use client";

import { useEffect, useState } from "react";

export function FieldConnectionStatus() {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const update = () => setOnline(window.navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  return <div className={`form-message ${online ? "success" : "error"}`} role="status" aria-live="polite">
    {online
      ? "Connected · member data stays network-only and is not stored for offline field use."
      : "Offline · secure member records and updates require a connection. Reconnect before continuing."}
  </div>;
}
