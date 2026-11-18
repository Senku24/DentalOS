"use client";
import * as RD from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./button";

interface OverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
}

function Head({ title, description }: { title: string; description?: string }) {
  return (
    <div className="dos-overlay-head">
      <div>
        <RD.Title className="dos-overlay-title">{title}</RD.Title>
        {description ? (
          <RD.Description className="dos-overlay-desc">{description}</RD.Description>
        ) : (
          <RD.Description className="dos-sr-only">{title}</RD.Description>
        )}
      </div>
      <RD.Close asChild>
        <Button variant="ghost" size="sm" iconOnly aria-label="Close">
          <X size={18} aria-hidden="true" />
        </Button>
      </RD.Close>
    </div>
  );
}

/** Modal dialog: focus trapped, Esc closes, focus returns to the trigger (Radix). */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
}: OverlayProps & { size?: "md" | "lg" }) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="dos-overlay" />
        <RD.Content className="dos-dialog" data-size={size}>
          <Head title={title} description={description} />
          <div className="dos-overlay-body">{children}</div>
          {footer ? <div className="dos-overlay-foot">{footer}</div> : null}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

/** Contextual side panel for details/edits without losing the working page. */
export function Drawer({
  side = "right",
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: OverlayProps & { side?: "right" | "left" }) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="dos-overlay" />
        <RD.Content className="dos-drawer" data-side={side}>
          <Head title={title} description={description} />
          <div className="dos-overlay-body">{children}</div>
          {footer ? <div className="dos-overlay-foot">{footer}</div> : null}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

/** For destructive/irreversible actions: explicit consequence text + cancel is the default focus. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  tone = "primary",
  loading,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  tone?: "primary" | "danger";
  loading?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} autoFocus>
            Cancel
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            loading={loading}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
