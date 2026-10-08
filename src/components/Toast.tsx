import { useEffect, useState } from "react";
import { useApp } from "../state/app";

export function Toaster() {
  const toast = useApp((s) => s.toast);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 3200);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <div aria-live="polite" role="status">
      {toast && visible && <div className="toast" key={toast.id}>{toast.text}</div>}
    </div>
  );
}
