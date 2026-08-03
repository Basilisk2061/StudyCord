import { useEffect, useEffectEvent, useId, useRef } from 'react';

const MENU_OPEN_EVENT = 'studycord:dismissable-menu-open';

export function dismissAllMenus() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(MENU_OPEN_EVENT));
}

export function useDismissableMenu({ open, onDismiss }) {
  const menuId = useId();
  const rootRef = useRef(null);
  const dismiss = useEffectEvent(() => onDismiss?.());

  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;

    const root = rootRef.current;
    const handlePointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) dismiss();
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        dismiss();
      }
    };
    const handleOtherMenu = (event) => {
      if (event.detail?.menuId !== menuId) dismiss();
    };
    const handleMenuAction = (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[role="menuitem"]')) dismiss();
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener(MENU_OPEN_EVENT, handleOtherMenu);
    root?.addEventListener('click', handleMenuAction);

    window.dispatchEvent(new CustomEvent(MENU_OPEN_EVENT, {
      detail: { menuId },
    }));

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener(MENU_OPEN_EVENT, handleOtherMenu);
      root?.removeEventListener('click', handleMenuAction);
    };
  }, [menuId, open]);

  return rootRef;
}
