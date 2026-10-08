import { useT } from "../i18n";
import { Modal } from "./Modal";

export function VideoErrorModal({ onClose }: { onClose(): void }) {
  const t = useT();
  return (
    <Modal title={t.videoError.title} onClose={onClose} actions={<button className="primary" onClick={onClose}>{t.common.ok}</button>}>
      <p>{t.videoError.text}</p>
    </Modal>
  );
}
