import { useState, useEffect, useRef } from "react";
import { useSettingsStore } from "../../core/store";
import { readingRhythmProgress, setWeeklyReadingGoal } from "../../core/lib/reading-rhythm";
import { Dropdown } from "../../ui/Dropdown";
import { Button } from "../../ui/Button";
import { ArrowLeft, ArrowRight, BookOpen, Compass, Library } from "lucide-react";
import { IconButton } from "../../ui/IconButton";
import { cn } from "../../core/lib/utils";
import { OnboardingFrame } from "./OnboardingFrame";
import { OnboardingFlow, ReaderIllustration, LibraryIllustration } from "./OnboardingFlow";

type Destination = "library" | "opds";
export function ReadingSetup({ onComplete }: { onComplete: (destination?: Destination) => void }) {
    const savedStep = useSettingsStore(s => s.readingSetupStep);
    const [step, setStep] = useState([0, 1, 2].includes(savedStep) ? savedStep : 0);
    const [days, setDays] = useState(4);
    const changedDays = useRef(false);
    useEffect(() => {
        let cancelled = false;
        void readingRhythmProgress().then(progress => {
            if (!cancelled && !changedDays.current && progress.nextTargetDays > 0) setDays(progress.nextTargetDays);
        }).catch(() => { /* Setup still supports choosing or skipping a goal. */ });
        return () => { cancelled = true; };
    }, []);
    const [busy, setBusy] = useState(false);
    const [tour, setTour] = useState(false);
    const [error, setError] = useState("");
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
    const back=<IconButton label="Back" className="min-h-11 min-w-11" icon={<ArrowLeft className="h-5 w-5" />} onClick={()=>go(step-1)} disabled={busy} />;
    const visual=step===0 ? <ReaderIllustration /> : step===2 ? <LibraryIllustration /> : <div className="flex w-full flex-col items-center gap-5">
        <div className="flex items-baseline gap-3"><span className="font-mono text-7xl text-[color:var(--color-accent)] sm:text-8xl">{days}</span><span className="text-sm text-[color:var(--color-text-secondary)]">days / week</span></div>
        <div className="flex w-full max-w-[320px] gap-2">{[1,2,3,4,5,6,7].map(day=><span key={day} className={cn("h-2 flex-1",day<=days ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]")} />)}</div>
    </div>;
    const actions=step===0 ? <>
        <Button variant="ghost" className="h-11" onClick={()=>setTour(true)}><BookOpen aria-hidden="true" className="h-4 w-4" />Explore features</Button>
        <Button variant="primary" className="h-11" onClick={()=>go(1)}>Start reading<ArrowRight aria-hidden="true" className="h-4 w-4" /></Button>
    </> : step===1 ? <>
        {back}
        <div className="ml-auto flex gap-3"><Button variant="ghost" className="h-11" onClick={()=>go(2)} disabled={busy}>Skip goal</Button><Button variant="primary" className="h-11" onClick={()=>void saveGoal()} disabled={busy}>Save rhythm<ArrowRight aria-hidden="true" className="h-4 w-4" /></Button></div>
    </> : back;
    return <OnboardingFrame label="Reading setup" title={["Make room for reading", "Choose your reading rhythm", "Bring your first book"][step]} step={step} total={3} visual={visual} actions={actions} onSkip={()=>onComplete("library")} busy={busy}>
        {step===0 && <>
            <p>Read your books. Keep what matters. Build a rhythm that fits your life.</p>
            <p className="text-xs text-[color:var(--color-text-muted)]">Your library stays on your device.</p>
        </>}
        {step===1 && <>
            <p>Five minutes makes a reading day. Choose how many days you want to read each week.</p>
            <div className="w-full max-w-[var(--layout-modal-width-sm)]">
                <label htmlFor="setup-reading-days" className="mb-2 block text-xs text-[color:var(--color-text-muted)]">Reading days per week</label>
                <Dropdown dropdownClassName="z-[calc(var(--z-modal)+1)]" id="setup-reading-days" aria-label="Reading days per week" className="h-11" value={String(days)} onChange={value=>{changedDays.current=true;setDays(Number(value));}} options={
                    [1,2,3,4,5,6,7].map(value=>({value:String(value),label:`${value} ${value===1 ? "day" : "days"}${value===4 ? " — recommended" : ""}`}))
                } />
            </div>
        </>}
        {step===2 && <>
            <p>Bring a book from your device, or find your next read in Discover.</p>
            <div className="flex flex-col gap-3 sm:flex-row">
                <Button variant="primary" className="h-11" aria-label="Open Library to add a book" onClick={()=>onComplete("library")}><Library aria-hidden="true" className="h-4 w-4" />Open Library</Button>
                <Button className="h-11" onClick={()=>onComplete("opds")}><Compass aria-hidden="true" className="h-4 w-4" />Browse Discover</Button>
            </div>
            <p className="text-xs text-[color:var(--color-text-muted)]">Reading goals can be changed in Settings.</p>
        </>}
        {error && <p role="alert" className="text-sm text-[color:var(--color-error)]">{error}</p>}
    </OnboardingFrame>;
}
