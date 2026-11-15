'use client';

import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

/** Diálogo modal nativo: foco preso, Escape fecha e o título nomeia o diálogo. */
export function Modal({ title, labelId, onClose, children }: { title: string; labelId: string; onClose: () => void; children: React.ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog ref={dialog} className="asset-dialog" aria-labelledby={labelId} onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <div className="panel-heading">
        <div><h2 id={labelId}>{title}</h2></div>
        <button className="button icon-button" type="button" onClick={onClose} aria-label="Fechar"><X size={20} aria-hidden="true" /></button>
      </div>
      {children}
    </dialog>
  );
}
