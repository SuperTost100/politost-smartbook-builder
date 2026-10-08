import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  variant?: 'modal' | 'wide' | 'drawer' | 'drawer-left';
  /** Extra class on the dialog element. */
  className?: string;
}

/**
 * Native <dialog>: the browser traps focus, closes on Esc and returns focus to the opener.
 * The component only mounts the dialog content while open.
 */
export function Dialog({ open, onClose, title, children, footer, variant = 'modal', className = '' }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  if (!open) return <dialog ref={ref} className="ui-dialog" hidden />;

  const cls = ['ui-dialog', variant === 'wide' && 'ui-dialog--wide', variant === 'drawer' && 'ui-dialog--drawer', variant === 'drawer-left' && 'ui-dialog--drawer ui-dialog--drawer-left', className].filter(Boolean).join(' ');
  return (
    <dialog
      ref={ref}
      className={cls}
      aria-labelledby={titleId}
      onClose={() => closeRef.current()}
      onCancel={(e) => { e.preventDefault(); closeRef.current(); }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) closeRef.current(); }}
    >
      <div className="ui-dialog__head">
        <h2 id={titleId} className="ui-panel-title">{title}</h2>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--icon ui-btn--sm" aria-label="Close" onClick={() => closeRef.current()}><Icon name="x" /></button>
      </div>
      <div className="ui-dialog__body">{children}</div>
      {footer && <div className="ui-dialog__foot">{footer}</div>}
    </dialog>
  );
}

export function ConfirmDialog(props: {
  open: boolean; title: string; message: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean;
  onConfirm: () => void; onClose: () => void;
}) {
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      footer={
        <>
          <button type="button" className="ui-btn" onClick={props.onClose}>Cancel</button>
          <button type="button" className={`ui-btn ${props.danger ? 'ui-btn--danger-solid' : 'ui-btn--accent'}`} disabled={props.busy} onClick={props.onConfirm}>{props.confirmLabel}</button>
        </>
      }
    >
      <div>{props.message}</div>
    </Dialog>
  );
}
