import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { cn } from "../../core/lib/utils";
import { TheoremLogo } from "../../shell/TheoremLogo";

interface OnboardingFrameProps {
    label: string;
    title: string;
    step: number;
    total: number;
    visual: ReactNode;
    children: ReactNode;
    actions: ReactNode;
    onSkip: () => void;
    skipLabel?: string;
    busy?: boolean;
    skipHidden?: boolean;
    onStepChange?: (step: number) => void;
}

/** One viewport layout for reading setup and the optional feature guide. */
export function OnboardingFrame({ label, title, step, total, visual, children, actions, onSkip, skipLabel = "Skip setup", busy = false, skipHidden = false, onStepChange }: OnboardingFrameProps) {
    const heading = useRef<HTMLHeadingElement>(null);
    useEffect(() => { heading.current?.focus(); }, [step]);
    return <div className="fixed inset-0 z-[var(--z-modal)] flex flex-col bg-[var(--color-background)] px-5 pt-[calc(var(--safe-area-top)+1rem)] pb-[calc(var(--safe-area-bottom)+1.25rem)] sm:px-10">
        <header className="mx-auto w-full max-w-[var(--container-width-lg)] shrink-0">
            <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 text-lg text-[color:var(--color-text-primary)]"><TheoremLogo size={28} /><span>Theorem</span></div>
                <Button variant="ghost" className={cn("h-11",skipHidden && "invisible")} onClick={onSkip} disabled={busy} tabIndex={skipHidden ? -1 : undefined} aria-hidden={skipHidden || undefined}>{skipLabel}</Button>
            </div>
            <div aria-label={`${label} progress`} className="mt-5 flex items-center gap-2">
                {Array.from({length:total},(_,index)=>{
                    const line=<span className={cn("block h-0.5 w-full",index===step ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]")} />;
                    return onStepChange
                        ? <IconButton key={index} label={`Go to step ${index+1}`} aria-current={index===step ? "step" : undefined} className="min-h-11 flex-1" icon={line} onClick={()=>onStepChange(index)} />
                        : <span key={index} aria-hidden="true" className="flex-1">{line}</span>;
                })}
            </div>
        </header>
        <main aria-label={label} aria-busy={busy} className="min-h-0 flex-1 overflow-y-auto overscroll-contain [content-visibility:auto]">
            <div className="mx-auto grid min-h-full w-full content-center max-w-[var(--container-width-lg)] items-center gap-6 py-6 sm:py-10 md:grid-cols-2 md:gap-12">
                <div className="min-w-0 md:order-first">
                    <p className="mb-4 font-mono text-xs text-[color:var(--color-text-muted)]">Step {step+1} of {total}</p>
                    <h1 ref={heading} tabIndex={-1} className="text-3xl leading-tight text-[color:var(--color-text-primary)] outline-none sm:text-4xl lg:text-5xl">{title}</h1>
                    <div className="mt-5 space-y-5 text-sm leading-relaxed text-[color:var(--color-text-secondary)] sm:text-base">{children}</div>
                </div>
                <div aria-hidden="true" className="order-first flex h-36 min-w-0 items-center justify-center sm:h-56 md:order-last md:h-80 [&_svg]:h-full [&_svg]:w-auto">{visual}</div>
            </div>
        </main>
        <footer className="mx-auto flex w-full max-w-[var(--container-width-lg)] shrink-0 flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] pt-4">{actions}</footer>
    </div>;
}
