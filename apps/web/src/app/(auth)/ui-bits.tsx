/** 认证页共享外壳：居中卡片 + 统一错误/提示渲染（M4）；密码字段带可见性切换（M10.6d） */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordField } from "@/components/auth/password-field";

export function AuthShell({
  title,
  error,
  message,
  children,
  footer,
}: {
  title: string;
  error?: string;
  message?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 px-4 py-16">
      <h1 className="text-center text-2xl font-bold tracking-tight">{title}</h1>
      {error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {message && (
        <p className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary">
          {message}
        </p>
      )}
      <div className="rounded-xl border bg-card p-6">{children}</div>
      {footer && <div className="text-center text-sm text-muted-foreground">{footer}</div>}
    </main>
  );
}

export function Field({
  label,
  name,
  type = "text",
  placeholder,
  required = true,
  autoComplete,
  password = false,
  minLength,
}: {
  label: string;
  name: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
  autoComplete?: string;
  /** 密码语义：渲染带可见性切换的输入（忽略 type） */
  password?: boolean;
  minLength?: number;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-sm text-muted-foreground">{label}</span>
      {password ? (
        <PasswordField
          name={name}
          placeholder={placeholder}
          required={required}
          autoComplete={autoComplete}
          minLength={minLength}
        />
      ) : (
        <Input
          name={name}
          type={type}
          placeholder={placeholder}
          required={required}
          autoComplete={autoComplete}
        />
      )}
    </label>
  );
}

export function SubmitButton({ label }: { label: string }) {
  return (
    <Button type="submit" className="mt-2 w-full">
      {label}
    </Button>
  );
}
