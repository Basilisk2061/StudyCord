import { useDismissableMenu } from '../hooks/useDismissableMenu';

export default function DismissableMenu({ open, onDismiss, children, ...props }) {
  const rootRef = useDismissableMenu({ open, onDismiss });

  return (
    <div ref={rootRef} {...props}>
      {children}
    </div>
  );
}
