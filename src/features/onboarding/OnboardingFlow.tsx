import { useState, useCallback } from "react";
import {
    Library,
    BookOpenText,
    Highlighter,
    FolderSync,
    ArrowRight,
    ArrowLeft,
} from "lucide-react";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { OnboardingFrame } from "./OnboardingFrame";
import { isTauriDesktop } from "../../core/lib/env";
import { TheoremLogo } from "../../shell/TheoremLogo";

interface OnboardingFlowProps {
    onComplete: () => void;
}

export function LibraryIllustration() {
    return (
        <svg
            viewBox="0 0 320 220"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="w-full max-w-[320px] h-auto"
            aria-hidden="true"
        >
            
            <rect x="0" y="0" width="60" height="220" fill="var(--color-surface-variant)" stroke="var(--color-border)" strokeWidth="1" />
            <rect x="12" y="16" width="36" height="4" fill="var(--color-text-primary)" />
            <rect x="12" y="32" width="36" height="3" fill="var(--color-text-muted)" />
            <rect x="12" y="44" width="36" height="3" fill="var(--color-text-muted)" />
            <rect x="12" y="56" width="36" height="3" fill="var(--color-text-muted)" />
            <rect x="12" y="68" width="36" height="3" fill="var(--color-text-muted)" />

            {[0, 1, 2].map((col) =>
                [0, 1].map((row) => {
                    const x = 76 + col * 82;
                    const y = 20 + row * 100;
                    const fills = [
                        "var(--color-text-primary)",
                        "var(--color-text-secondary)",
                        "var(--color-border)",
                        "var(--color-text-muted)",
                        "var(--color-text-primary)",
                        "var(--color-surface-variant)",
                    ];
                    return (
                        <g key={`${col}-${row}`}>
                            <rect
                                x={x}
                                y={y}
                                width="68"
                                height="88"
                                fill={fills[row * 3 + col]}
                                stroke="var(--color-border)"
                                strokeWidth="1"
                            />
                            
                            <rect x={x + 10} y={y + 60} width="48" height="3" fill="var(--color-surface)" opacity="0.6" />
                            <rect x={x + 10} y={y + 68} width="32" height="2" fill="var(--color-surface)" opacity="0.4" />
                        </g>
                    );
                }),
            )}
        </svg>
    );
}

export function ReaderIllustration() {
    return (
        <svg
            viewBox="0 0 320 220"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="w-full max-w-[320px] h-auto"
            aria-hidden="true"
        >
            
            <rect x="20" y="10" width="280" height="200" fill="var(--color-surface)" stroke="var(--color-border)" strokeWidth="1" />

            {Array.from({ length: 12 }).map((_, i) => (
                <rect
                    key={`line-${i}`}
                    x="40"
                    y={30 + i * 14}
                    width={i % 3 === 2 ? 180 : 240}
                    height="3"
                    fill="var(--color-text-muted)"
                    opacity="0.4"
                />
            ))}

            <rect x="40" y="72" width="240" height="14" fill="var(--highlight-yellow-soft)" />
            <rect x="40" y="72" width="240" height="3" fill="var(--highlight-yellow)" opacity="0.8" />
            <rect x="40" y="86" width="160" height="14" fill="var(--highlight-yellow-soft)" />
            <rect x="40" y="86" width="160" height="3" fill="var(--highlight-yellow)" opacity="0.8" />

            <rect x="90" y="12" width="140" height="24" fill="var(--color-text-primary)" />
            <circle cx="110" cy="24" r="4" fill="var(--color-surface)" />
            <circle cx="130" cy="24" r="4" fill="var(--highlight-yellow)" />
            <circle cx="150" cy="24" r="4" fill="var(--highlight-blue)" />
            <circle cx="170" cy="24" r="4" fill="var(--highlight-green)" />
            <circle cx="190" cy="24" r="4" fill="var(--highlight-red)" />
            <rect x="204" y="20" width="16" height="8" fill="var(--color-surface)" opacity="0.5" />
        </svg>
    );
}

function FormatsIllustration() {
    return (
        <svg
            viewBox="0 0 320 220"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="w-full max-w-[320px] h-auto"
            aria-hidden="true"
        >
            
            {[
                { label: "PDF", x: 30, y: 40, fill: "var(--color-text-primary)" },
                { label: "EPUB", x: 90, y: 25, fill: "var(--color-text-secondary)" },
                { label: "MOBI", x: 150, y: 40, fill: "var(--color-text-muted)" },
                { label: "RSS", x: 210, y: 25, fill: "var(--color-text-primary)" },
            ].map(({ label, x, y, fill }) => (
                <g key={label}>
                    <rect x={x} y={y} width="72" height="100" fill={fill} stroke="var(--color-border)" strokeWidth="1" />
                    
                    <rect x={x} y={y + 80} width="72" height="20" fill="var(--color-surface)" />
                    
                    <text
                        x={x + 36}
                        y={y + 94}
                        textAnchor="middle"
                        fill="var(--color-text-primary)"
                        fontSize="10"
                        fontWeight="400"
                        fontFamily="var(--font-sans)"
                        letterSpacing="0.1em"
                    >
                        {label}
                    </text>
                    
                    <rect x={x + 12} y={y + 16} width="48" height="2" fill="var(--color-surface)" opacity="0.5" />
                    <rect x={x + 12} y={y + 24} width="36" height="2" fill="var(--color-surface)" opacity="0.3" />
                    <rect x={x + 12} y={y + 32} width="48" height="2" fill="var(--color-surface)" opacity="0.5" />
                    <rect x={x + 12} y={y + 40} width="24" height="2" fill="var(--color-surface)" opacity="0.3" />
                </g>
            ))}

            <path d="M160 150 L160 170" stroke="var(--color-text-primary)" strokeWidth="2" />
            <polygon points="155,170 165,170 160,178" fill="var(--color-text-primary)" />

            <rect x="80" y="182" width="160" height="28" fill="var(--color-text-primary)" />
            <text
                x="160"
                y="200"
                textAnchor="middle"
                fill="var(--color-surface)"
                fontSize="9"
                fontWeight="400"
                fontFamily="var(--font-sans)"
                letterSpacing="0.12em"
            >
                ONE READER
            </text>
        </svg>
    );
}

function VaultIllustration() {
    return (
        <svg
            viewBox="0 0 320 220"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="w-full max-w-[320px] h-auto"
            aria-hidden="true"
        >
            
            <rect x="20" y="40" width="90" height="130" fill="var(--color-text-primary)" stroke="var(--color-border)" strokeWidth="1" />
            <rect x="30" y="56" width="70" height="3" fill="var(--color-surface)" opacity="0.5" />
            <rect x="30" y="66" width="70" height="3" fill="var(--color-surface)" opacity="0.5" />
            <rect x="30" y="76" width="50" height="10" fill="var(--highlight-yellow-soft)" />
            <rect x="30" y="76" width="50" height="3" fill="var(--highlight-yellow)" />
            <rect x="30" y="92" width="70" height="3" fill="var(--color-surface)" opacity="0.5" />
            <rect x="30" y="102" width="60" height="10" fill="var(--highlight-blue-soft)" />
            <rect x="30" y="102" width="60" height="3" fill="var(--highlight-blue)" />
            <rect x="30" y="118" width="70" height="3" fill="var(--color-surface)" opacity="0.5" />
            <rect x="30" y="128" width="45" height="10" fill="var(--highlight-green-soft)" />
            <rect x="30" y="128" width="45" height="3" fill="var(--highlight-green)" />

            <path d="M125 105 L185 105" stroke="var(--color-text-primary)" strokeWidth="2" strokeDasharray="6 3" />
            <polygon points="185,100 185,110 195,105" fill="var(--color-text-primary)" />

            <rect x="205" y="30" width="95" height="160" fill="var(--color-surface)" stroke="var(--color-border)" strokeWidth="1" />
            
            <rect x="215" y="42" width="8" height="8" fill="var(--color-text-primary)" />
            <rect x="228" y="44" width="60" height="4" fill="var(--color-text-primary)" />
            
            <rect x="215" y="60" width="4" height="4" fill="var(--highlight-yellow)" />
            <rect x="224" y="61" width="64" height="2" fill="var(--color-text-muted)" />
            <rect x="224" y="67" width="48" height="2" fill="var(--color-text-muted)" opacity="0.5" />

            <rect x="215" y="78" width="4" height="4" fill="var(--highlight-blue)" />
            <rect x="224" y="79" width="56" height="2" fill="var(--color-text-muted)" />
            <rect x="224" y="85" width="40" height="2" fill="var(--color-text-muted)" opacity="0.5" />

            <rect x="215" y="96" width="4" height="4" fill="var(--highlight-green)" />
            <rect x="224" y="97" width="60" height="2" fill="var(--color-text-muted)" />
            <rect x="224" y="103" width="52" height="2" fill="var(--color-text-muted)" opacity="0.5" />

            <rect x="215" y="116" width="75" height="1" fill="var(--color-border)" />

            <rect x="215" y="126" width="8" height="8" fill="var(--color-text-primary)" />
            <rect x="228" y="128" width="50" height="4" fill="var(--color-text-primary)" />
            <rect x="215" y="142" width="4" height="4" fill="var(--color-text-secondary)" />
            <rect x="224" y="143" width="52" height="2" fill="var(--color-text-muted)" />
            <rect x="215" y="154" width="4" height="4" fill="var(--color-text-secondary)" />
            <rect x="224" y="155" width="44" height="2" fill="var(--color-text-muted)" />

            <text
                x="252"
                y="204"
                textAnchor="middle"
                fill="var(--color-text-secondary)"
                fontSize="8"
                fontWeight="400"
                fontFamily="var(--font-sans)"
                letterSpacing="0.08em"
            >
                .md
            </text>
        </svg>
    );
}

function WelcomeIllustration() {
    return (
        <div className="flex items-center justify-center">
            <TheoremLogo size={96} />
        </div>
    );
}

interface OnboardingStep {
    id: string;
    icon: React.ReactNode;
    title: string;
    subtitle: string;
    description: string;
    illustration: React.ReactNode;
}

// Markdown export only exists in the desktop app.
const canExportMarkdown = isTauriDesktop();

const steps: OnboardingStep[] = [
    {
        id: "welcome",
        icon: <TheoremLogo size={20} />,
        title: "Welcome to Theorem",
        subtitle: "Own your reading data. Forever.",
        description:
            "A free, local-first reading app. No cloud account. No subscription. Your books, highlights, and notes stay on your device.",
        illustration: <WelcomeIllustration />,
    },
    {
        id: "formats",
        icon: <Library className="h-5 w-5" />,
        title: "Read Anything",
        subtitle: "All formats, one reader.",
        description:
            "Read PDFs, ebooks, comics, and feeds in one place.",
        illustration: <FormatsIllustration />,
    },
    {
        id: "reader",
        icon: <Highlighter className="h-5 w-5" />,
        title: "Highlight and Annotate",
        subtitle: "Capture what matters while you read.",
        description:
            "Highlight a passage, leave a note, or look up a word without leaving your book.",
        illustration: <ReaderIllustration />,
    },
    {
        id: "library",
        icon: <BookOpenText className="h-5 w-5" />,
        title: "Organize Your Library",
        subtitle: "Shelves, tags, and smart collections.",
        description:
            "Group books into shelves. Filter by format, reading status, or favorites. Track your reading statistics and set daily goals.",
        illustration: <LibraryIllustration />,
    },
    {
        id: "vault",
        icon: <FolderSync className="h-5 w-5" />,
        title: "Sync Across Devices",
        subtitle: canExportMarkdown ? "P2P sync + markdown export." : "Peer-to-peer sync.",
        description: canExportMarkdown
            ? "Pair a device with a QR code and your progress, highlights and books sync straight between them, at home or away. Export to Markdown vaults for long-term ownership. No account, no cloud."
            : "Pair a device with a QR code and your progress, highlights and books sync straight between them, at home or away. No account, no cloud.",
        illustration: <VaultIllustration />,
    },
];

export function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
    const [currentStep, setCurrentStep] = useState(0);
    const step = steps[currentStep];
    const isFirst = currentStep === 0;
    const isLast = currentStep === steps.length - 1;

    const handleNext = useCallback(() => {
        if (isLast) {
            onComplete();
        } else {
            setCurrentStep((prev) => prev + 1);
        }
    }, [isLast, onComplete]);

    const handleBack = useCallback(() => {
        if (!isFirst) {
            setCurrentStep((prev) => prev - 1);
        }
    }, [isFirst]);

    const handleSkip = useCallback(() => {
        onComplete();
    }, [onComplete]);

    return <OnboardingFrame label="Feature guide" title={step.title} step={currentStep} total={steps.length} visual={step.illustration} onSkip={handleSkip} skipLabel="Skip" skipHidden={isLast} onStepChange={setCurrentStep} actions={<>
        <IconButton label="Back" className="min-h-11 min-w-11" icon={<ArrowLeft className="h-5 w-5" />} onClick={handleBack} disabled={isFirst} />
        <Button variant="primary" className="h-11" onClick={handleNext}>{isLast ? "Get Started" : "Next"}<ArrowRight aria-hidden="true" className="h-4 w-4" /></Button>
    </>}>
        <p className="text-[color:var(--color-text-primary)]">{step.subtitle}</p>
        <p>{step.description}</p>
    </OnboardingFrame>;
}
