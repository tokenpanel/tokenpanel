import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface ConfirmOptions {
  title: string;
  /** What happens, and whether it can be undone. */
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm key for irreversible or access-removing actions. */
  destructive?: boolean;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = React.createContext<ConfirmFn | null>(null);

/** Promise-based confirmation dialog replacing window.confirm. */
export function ConfirmProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [state, setState] = React.useState<(ConfirmOptions & { open: boolean }) | null>(null);
  const resolver = React.useRef<((ok: boolean) => void) | null>(null);

  const confirm = React.useCallback<ConfirmFn>((options) => {
    resolver.current?.(false);
    setState({ ...options, open: true });
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = React.useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setState((s) => (s ? { ...s, open: false } : s));
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={state?.open ?? false} onOpenChange={(o) => (o ? null : settle(false))}>
        {state ? (
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{state.title}</DialogTitle>
              {state.description ? (
                <DialogDescription className="leading-relaxed">{state.description}</DialogDescription>
              ) : null}
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => settle(false)}>
                {state.cancelLabel ?? "Cancel"}
              </Button>
              <Button
                type="button"
                variant={state.destructive ? "destructive" : "default"}
                autoFocus
                onClick={() => settle(true)}
              >
                {state.confirmLabel ?? "Confirm"}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = React.useContext(ConfirmContext);
  if (ctx) return ctx;
  // Outside the provider (tests, isolated renders): fall back to the browser.
  return async (o) => window.confirm(o.title);
}
