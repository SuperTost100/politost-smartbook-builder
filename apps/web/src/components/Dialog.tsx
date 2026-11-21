import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  variant?: 'modal' | 'wide' | 'drawer' | 'drawer-left';
  /** Extra class on the dialog element. */
  className?: string;
  /** Escape and a click outside do nothing while this is set (work is running that a stray key must not abandon). The close button still works. */
  holdEscape?: boolean;
  /** Nothing in the body can be focused or clicked while this is set (the footer is asking a question that comes first). */
  inertBody?: boolean;
}

const FOCUSABLE = 'a[href], button, input, textarea, select, summary, [tabindex], .cm-content';

/**
 * A radio that Tab skips: one of a group whose checked radio, or failing that its first enabled one, is the one Tab stops
 * on. The group is the radios of the same name, form and dialog.
 */
function skippedRadio(el: HTMLElement, dialog: HTMLDialogElement) {
  if (!(el instanceof HTMLInputElement) || el.type !== 'radio' || !el.name || el.checked) return false;
  const group = [...dialog.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(el.name)}"]`)]
    .filter((r) => r.form === el.form && r.closest('dialog') === dialog && !r.disabled);
  return group.some((r) => r.checked) || group[0] !== el;
}

/**
 * Moves focus from the last control to the first (or the other way round), when Tab would leave the dialog. A modal
 * <dialog> keeps focus out of the page, but from its last control Tab moves to the browser's toolbar, or to the page's
 * body where there is none.
 */
function wrapFocus(e: React.KeyboardEvent<HTMLDialogElement>) {
  if (e.key !== 'Tab' || e.defaultPrevented) return;
  const dialog = e.currentTarget;
  const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.closest('dialog') === dialog && el.tabIndex >= 0 && !el.matches(':disabled') && !el.closest('[inert]') && el.getClientRects().length > 0 && !skippedRadio(el, dialog));
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) return;
  const at = document.activeElement;
  if (e.shiftKey ? at === first : at === last) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
}

/**
 * Native <dialog>: the browser traps focus, closes on Esc and returns focus to the opener.
 * The component only mounts the dialog content while open.
 */
export function Dialog({ open, onClose, title, children, footer, variant = 'modal', className = '', holdEscape, inertBody }: DialogProps) {
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
      onKeyDown={wrapFocus}
      onCancel={(e) => { e.preventDefault(); if (!holdEscape) closeRef.current(); }}
      onMouseDown={(e) => { if (e.target === e.currentTarget && !holdEscape) closeRef.current(); }}
    >
      <div className="ui-dialog__head">
        <h2 id={titleId} className="ui-panel-title">{title}</h2>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--icon ui-btn--sm" aria-label="Close" onClick={() => closeRef.current()}><Icon name="x" /></button>
      </div>
      <div className="ui-dialog__body" inert={inertBody}>{children}</div>
      {footer && <div className="ui-dialog__foot">{footer}</div>}
    </dialog>
  );
}

export function ConfirmDialog(props: {
  open: boolean; title: string; message: ReactNode; confirmLabel: string; /** What the dismiss button says. Default "Cancel", which is wrong when the confirmed action is itself a cancellation. */ cancelLabel?: string; danger?: boolean; busy?: boolean;
  /** A second way to go ahead, shown between the dismiss and the confirm buttons. */
  alternative?: { label: string; onClick: () => void };
  onConfirm: () => void; onClose: () => void;
}) {
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      footer={
        <>
          <button type="button" className="ui-btn" onClick={props.onClose}>{props.cancelLabel ?? 'Cancel'}</button>
          {props.alternative && <button type="button" className="ui-btn" disabled={props.busy} onClick={props.alternative.onClick}>{props.alternative.label}</button>}
          <button type="button" className={`ui-btn ${props.danger ? 'ui-btn--danger-solid' : 'ui-btn--accent'}`} disabled={props.busy} onClick={props.onConfirm}>{props.confirmLabel}</button>
        </>
      }
    >
      <div>{props.message}</div>
    </Dialog>
  );
}
