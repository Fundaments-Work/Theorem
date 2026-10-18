import type { ReactNode } from "react";

interface PageHeaderProps {
    title: string;
    description?: ReactNode;
    children?: ReactNode;
}

export function PageHeader({ title, description, children }: PageHeaderProps) {
    return (
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
                <h1 className="m-0 font-sans text-xl leading-[1.1] text-[color:var(--color-text-primary)] sm:text-2xl">
                    {title}
                </h1>
                {description && (
                    <p className="mt-1 text-sm leading-relaxed text-[color:var(--color-text-secondary)]">
                        {description}
                    </p>
                )}
            </div>
            {children && <div className="flex items-center gap-2 sm:gap-4 ml-auto">{children}</div>}
        </div>
    );
}
