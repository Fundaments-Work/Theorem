import { useState, useEffect, useRef } from "react";
import { useSettingsStore } from "../../core/store";
import { setWeeklyReadingGoal } from "../../core/lib/reading-rhythm";
import { Dropdown } from "../../ui/Dropdown";
import { Button } from "../../ui/Button";
import { TheoremLogo } from "../../shell/TheoremLogo";
import { OnboardingFlow } from "./OnboardingFlow";

type Destination = "library" | "opds";
export function ReadingSetup({ onComplete }: { onComplete: (destination?: Destination) => void }) {
    const savedStep = useSettingsStore(s => s.readingSetupStep);
    const [step, setStep] = useState([0, 1, 2].includes(savedStep) ? savedStep : 0);
    const [days, setDays] = useState(4);
    const [busy, setBusy] = useState(false);
    const [tour, setTour] = useState(false);
    const [error, setError] = useState("");
    const heading = useRef<HTMLHeadingElement>(null);
    useEffect(() => { if (!tour) heading.current?.focus(); }, [step, tour]);
    function go(next: number) {
        setStep(next);
        setError("");
        useSettingsStore.setState({ readingSetupStep: next });
    }
    async function saveGoal() {
        setBusy(true);
        try { await setWeeklyReadingGoal(days); go(2); }
        catch { setError("Your goal could not be saved. Try again, or skip this step."); }
        finally { setBusy(false); }
    }
    if (tour) return <OnboardingFlow onComplete={() => setTour(false)} />;
    return <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[var(--color-background)] p-4 pt-[calc(var(--safe-area-top)+1rem)] pb-[calc(var(--safe-area-bottom)+1rem)]">
        <main aria-label="Reading setup" aria-busy={busy} className="flex max-h-full w-full max-w-lg flex-col overflow-y-auto overscroll-contain border border-[var(--color-border)] bg-[var(--color-surface)] p-6 [content-visibility:auto] sm:p-10">
            <div className="flex items-center justify-between gap-4">
                <TheoremLogo size={32} />
                <Button variant="ghost" className="min-h-11" onClick={() => onComplete("library")} disabled={busy}>Skip setup</Button>
            </div>
            <p className="mt-8 text-xs text-[color:var(--color-text-muted)]">Step {step + 1} of 3</p>
            <h1 ref={heading} tabIndex={-1} className="mt-3 text-2xl text-[color:var(--color-text-primary)]">{["Make room for reading", "Choose your reading rhythm", "Bring your first book"][step]}</h1>
            {step === 0 && <>
                <p className="mt-4 text-sm text-[color:var(--color-text-secondary)]">Your books, highlights, and notes stay on your device. No cloud account or subscription needed.</p>
                <Button variant="primary" className="mt-8 min-h-11" onClick={() => go(1)}>Start reading</Button>
                <Button variant="ghost" className="mt-3 min-h-11" onClick={() => setTour(true)}>Explore features</Button>
            </>}
            {step === 1 && <>
                <p className="mt-4 text-sm text-[color:var(--color-text-secondary)]">Read for 5 minutes to count a day. Aim for a few days each week, with room for busy days.</p>
                <label className="mt-6 text-sm text-[color:var(--color-text-primary)]" htmlFor="setup-reading-days">Reading days per week</label>
                <Dropdown dropdownClassName="z-[calc(var(--z-modal)+1)]" id="setup-reading-days" aria-label="Reading days per week" className="mt-2 min-h-11" value={String(days)} onChange={value => setDays(Number(value))} options={
                    [1,2,3,4,5,6,7].map(value => ({ value: String(value), label: `${value} ${value === 1 ? "day" : "days"}${value === 4 ? " — recommended" : ""}` }))
                } />
                <div className="mt-8 flex flex-wrap gap-3">
                    <Button className="min-h-11" onClick={() => go(0)} disabled={busy}>Back</Button>
                    <Button variant="primary" className="min-h-11" onClick={() => void saveGoal()} disabled={busy}>Save rhythm</Button>
                    <Button variant="ghost" className="min-h-11" onClick={() => go(2)} disabled={busy}>Skip goal</Button>
                </div>
            </>}
            {step === 2 && <>
                <p className="mt-4 text-sm text-[color:var(--color-text-secondary)]">Add a book from this device in Library, or find a free book in Discover. You can change your reading goal in Settings.</p>
                <div className="mt-8 flex flex-wrap gap-3">
                    <Button className="min-h-11" onClick={() => go(1)}>Back</Button>
                    <Button variant="primary" className="min-h-11" onClick={() => onComplete("library")}>Open Library to add a book</Button>
                    <Button className="min-h-11" onClick={() => onComplete("opds")}>Browse Discover</Button>
                </div>
            </>}
            {error && <p role="alert" className="mt-4 text-sm text-[color:var(--color-error)]">{error}</p>}
        </main>
    </div>;
}
