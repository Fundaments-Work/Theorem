
import { useState, useEffect, useRef, useCallback } from "react";
import {
    X,
    Sun,
    Moon,
    Sunrise,
    Plus,
    Minus,
    Layers,
    ArrowUpDown,
    AlignLeft,
    AlignJustify,
    AlignCenter,
    Type,
    Palette,
    Maximize2,
    Zap,
    Settings2,
} from "lucide-react";
import { cn } from "../../../core/lib/utils";
import { isFixedLayout, type BookFormat, type FontFamily, type ReaderSettings as ReaderSettingsType, type ReaderTheme } from "../../../core/types";
import { Backdrop, FloatingPanel } from "../../../ui";

interface ReaderSettingsProps {
    settings: ReaderSettingsType;
    visible: boolean;
    onClose: () => void;
    onUpdate: (updates: Partial<ReaderSettingsType>) => void;
    format?: BookFormat;
    className?: string;
}

type TabId = "themes" | "typography" | "zoom" | "layout";

const THEMES: Array<{
    id: ReaderTheme;
    label: string;
    icon: React.ReactNode;
}> = [
    {
        id: "light",
        label: "Light",
        icon: <Sun className="w-5 h-5" />,
    },
    {
        id: "sepia",
        label: "Sepia",
        icon: <Sunrise className="w-5 h-5" />,
    },
    {
        id: "dark",
        label: "Dark",
        icon: <Moon className="w-5 h-5" />,
    },
];

const FONTS: Array<{ id: FontFamily; label: string; family: string }> = [
    { id: "original", label: "Original", family: "inherit" },
    { id: "serif", label: "Serif", family: 'var(--font-merriweather), Georgia, serif' },
    { id: "sans", label: "Sans", family: 'var(--font-sans), system-ui, sans-serif' },
    { id: "mono", label: "Mono", family: 'var(--font-mono), monospace' },
];

const FLOW_OPTIONS = [
    { id: "paged", label: "Paged", icon: Layers },
    { id: "scroll", label: "Scroll", icon: ArrowUpDown },
] as const;

const ALIGN_OPTIONS = [
    { id: "left", label: "Left", icon: AlignLeft },
    { id: "justify", label: "Justify", icon: AlignJustify },
    { id: "center", label: "Center", icon: AlignCenter },
] as const;

function useSmoothSlider(
    initialValue: number,
    onChange: (value: number) => void,
    min: number,
    max: number,
    step: number = 1,
) {
    const [localValue, setLocalValue] = useState(initialValue);
    const isDraggingRef = useRef(false);

    useEffect(() => {
        if (!isDraggingRef.current) {
            setLocalValue(initialValue);
        }
    }, [initialValue]);

    const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const value = step < 1 ? Number.parseFloat(e.target.value) : Number.parseInt(e.target.value, 10);
        const clamped = Math.max(min, Math.min(max, value));
        setLocalValue(clamped);
        onChange(clamped);
    }, [max, min, onChange, step]);

    const handleMouseDown = useCallback(() => {
        isDraggingRef.current = true;
    }, []);

    const handleMouseUp = useCallback(() => {
        isDraggingRef.current = false;
    }, []);

    const increment = useCallback(() => {
        const next = Math.min(max, localValue + step);
        setLocalValue(next);
        onChange(next);
    }, [localValue, max, step, onChange]);

    const decrement = useCallback(() => {
        const next = Math.max(min, localValue - step);
        setLocalValue(next);
        onChange(next);
    }, [localValue, min, step, onChange]);

    const epsilon = Math.max(0.0001, step / 1000);
    const canDecrement = localValue > min + epsilon;
    const canIncrement = localValue < max - epsilon;

    return {
        value: localValue,
        min,
        max,
        step,
        handleChange,
        handleMouseDown,
        handleMouseUp,
        increment,
        decrement,
        canDecrement,
        canIncrement,
    };
}

export function ReaderSettings({
    settings,
    visible,
    onClose,
    onUpdate,
    format = "epub",
    className,
}: ReaderSettingsProps) {
    const [activeTab, setActiveTab] = useState<TabId>("themes");
    const [showAdvancedType, setShowAdvancedType] = useState(false);

    const isFixed = isFixedLayout(format);
    const reflowZoomMin = settings.flow === "paged" ? 100 : 50;

    const brightnessSlider = useSmoothSlider(
        settings.brightness ?? 100,
        (value) => onUpdate({ brightness: value }),
        20,
        100,
        1,
    );

    const fontSizeSlider = useSmoothSlider(
        settings.fontSize ?? 18,
        (value) => onUpdate({ fontSize: value }),
        12,
        32,
        1,
    );

    const lineHeightSlider = useSmoothSlider(
        settings.lineHeight ?? 1.6,
        (value) => onUpdate({ lineHeight: value }),
        1.0,
        2.2,
        0.1,
    );

    const zoomSlider = useSmoothSlider(
        settings.zoom ?? 100,
        (value) => onUpdate({ zoom: value }),
        isFixed ? 50 : reflowZoomMin,
        200,
        10,
    );

    const currentFontFamily = FONTS.find((font) => font.id === settings.fontFamily)?.family;

    const handleReset = useCallback(() => {
        onUpdate({
            theme: "light",
            fontFamily: "original",
            fontSize: 18,
            lineHeight: 1.6,
            letterSpacing: 0,
            wordSpacing: 0,
            paragraphSpacing: 1,
            textAlign: "left",
            hyphenation: false,
            margins: 10,
            zoom: 100,
            flow: "paged",
            layout: "auto",
            brightness: 100,
            forcePublisherStyles: false,
        });
    }, [onUpdate]);

    const tabs = [
        { id: "themes" as TabId, label: "Theme", icon: <Palette className="w-4 h-4" /> },
        isFixed
            ? { id: "zoom" as TabId, label: "Zoom", icon: <Zap className="w-4 h-4" /> }
            : { id: "typography" as TabId, label: "Type", icon: <Type className="w-4 h-4" /> },
        { id: "layout" as TabId, label: "Layout", icon: <Maximize2 className="w-4 h-4" /> },
    ];

    return (
        <>
            <Backdrop visible={visible} onClick={onClose} />

            <FloatingPanel visible={visible} className={cn("overflow-hidden bg-[var(--color-surface)]", className)}>
                <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-3.5">
                    <div className="flex items-center gap-2.5">
                        <span className="inline-flex h-10 w-10 items-center justify-center bg-[var(--color-surface-muted)]">
                            <Settings2 className="w-4 h-4 text-[color:var(--color-text-secondary)]" />
                        </span>
                        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-text-primary)]">Settings</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={handleReset}
                            className="relative px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)] transition-colors"
                        >
                            Reset
                        </button>
                        <button
                            onClick={onClose}
                            className="inline-flex h-10 w-10 items-center justify-center text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)] transition-colors"
                            aria-label="Close settings"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                </div>

                <div className="px-5 pt-3.5 pb-2.5">
                    <div className="flex border border-[var(--color-border)] divide-x divide-[var(--color-border)]">
                        {tabs.map((tab) => (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id)}
                                className="flex-1 relative py-2 text-[10px] font-bold uppercase tracking-[0.08em] transition-colors text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)] data-[active]:text-[color:var(--color-text-primary)]"
                                data-active={activeTab === tab.id}
                                aria-pressed={activeTab === tab.id}
                            >
                                <span className="inline-flex items-center justify-center gap-1.5">
                                    {tab.icon}
                                    <span>{tab.label}</span>
                                </span>
                                {activeTab === tab.id && (
                                    <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-[var(--color-text-primary)]" />
                                )}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-5 [content-visibility:auto] overscroll-contain">
                    {activeTab === "themes" && (
                        <div className="space-y-5">
                            <div>
                                <div className="flex items-center justify-between mb-3">
                                    <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-text-muted)]">Brightness</span>
                                    <span className="[font-variant-numeric:tabular-nums] text-[11px] text-[color:var(--color-text-primary)]">
                                        {brightnessSlider.value}%
                                    </span>
                                </div>
                                <div className="flex items-center gap-2.5">
                                    <button
                                        onClick={brightnessSlider.decrement}
                                        className="inline-flex h-10 w-10 items-center justify-center border border-[var(--color-border)] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)] transition-colors disabled:opacity-30"
                                        aria-label="Decrease brightness"
                                        disabled={!brightnessSlider.canDecrement}
                                    >
                                        <Minus className="w-4 h-4" />
                                    </button>
                                    <input
                                        type="range"
                                        min={brightnessSlider.min}
                                        max={brightnessSlider.max}
                                        step={brightnessSlider.step}
                                        value={brightnessSlider.value}
                                        onChange={brightnessSlider.handleChange}
                                        onMouseDown={brightnessSlider.handleMouseDown}
                                        onMouseUp={brightnessSlider.handleMouseUp}
                                        className="ui-reader-slider flex-1"
                                    />
                                    <button
                                        onClick={brightnessSlider.increment}
                                        className="inline-flex h-10 w-10 items-center justify-center border border-[var(--color-border)] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)] transition-colors disabled:opacity-30"
                                        aria-label="Increase brightness"
                                        disabled={!brightnessSlider.canIncrement}
                                    >
                                        <Plus className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>

                            <div>
                                <span className="block mb-3 text-[10px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-text-muted)]">Theme</span>
                                <div className="grid grid-cols-3 gap-2">
                                    {THEMES.map((theme) => {
                                        const active = settings.theme === theme.id;
                                        return (
                                            <button
                                                key={theme.id}
                                                onClick={() => onUpdate({ theme: theme.id })}
                                                className={cn(
                                                    "relative border transition-colors",
                                                    active
                                                        ? "border-[var(--color-text-primary)]"
                                                        : "border-[var(--color-border)] hover:border-[var(--color-text-muted)]"
                                                )}
                                                aria-pressed={active}
                                            >
                                                <div
                                                    className="h-20 flex items-center justify-center"
                                                    data-theme={theme.id}
                                                    style={{
                                                        backgroundColor: theme.id === 'dark' ? '#1a1a1a' : theme.id === 'sepia' ? '#fbf3e0' : '#ffffff',
                                                        color: theme.id === 'dark' ? '#e5e5e5' : theme.id === 'sepia' ? '#5f4b32' : '#1a1a1a',
                                                    }}
                                                >
                                                    <div className="flex flex-col items-center gap-1.5 opacity-70">
                                                        <span className="block text-lg leading-none">Aa</span>
                                                        <span className="block text-[8px] leading-none uppercase tracking-[0.15em]">{theme.label}</span>
                                                    </div>
                                                </div>
                                                {active && (
                                                    <span className="absolute -top-1 -right-1 w-3.5 h-3.5 flex items-center justify-center bg-[var(--color-text-primary)] text-[var(--color-surface)]">
                                                        <span className="text-[8px] leading-none">&#10003;</span>
                                                    </span>
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === "typography" && (
                        <div className="space-y-4.5">
                            <div>
                                <span className="block mb-2.5 text-[10px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-text-muted)]">Font</span>
                                <div className="grid grid-cols-2 gap-1.5">
                                    {FONTS.map((font) => {
                                        const active = settings.fontFamily === font.id;
                                        return (
                                            <button
                                                key={font.id}
                                                onClick={() => onUpdate({ fontFamily: font.id })}
                                                className={cn(
                                                    "relative px-3 py-2.5 text-left border transition-colors",
                                                    active
                                                        ? "border-[var(--color-text-primary)]"
                                                        : "border-[var(--color-border)] hover:border-[var(--color-text-muted)]"
                                                )}
                                                aria-pressed={active}
                                                style={{ fontFamily: font.family }}
                                            >
                                                <span className="block text-sm font-medium">{font.label}</span>
                                                <span className="mt-0.5 block text-[10px] text-[color:var(--color-text-muted)]">Aa Bb Cc</span>
                                            </button>
                                        );
                                    })}
                                </div>

                                <div className="mt-3 border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] px-4 py-4 text-center text-base leading-relaxed text-[color:var(--color-text-primary)]" style={{ fontFamily: currentFontFamily }}>
                                    The quick brown fox jumps over the lazy dog
                                </div>
                            </div>

                            <div>
                                <div className="flex items-center justify-between mb-3">
                                    <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-text-muted)]">Size</span>
                                    <span className="[font-variant-numeric:tabular-nums] text-[11px] text-[color:var(--color-text-primary)]">{fontSizeSlider.value}</span>
                                </div>
                                <div className="flex items-center gap-2.5">
                                    <button
                                        onClick={fontSizeSlider.decrement}
                                        className="inline-flex h-10 w-10 items-center justify-center border border-[var(--color-border)] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)] transition-colors disabled:opacity-30"
                                        aria-label="Decrease font size"
                                        disabled={!fontSizeSlider.canDecrement}
                                    >
                                        <Minus className="w-4 h-4" />
                                    </button>
                                    <input
                                        type="range"
                                        min={fontSizeSlider.min}
                                        max={fontSizeSlider.max}
                                        step={fontSizeSlider.step}
                                        value={fontSizeSlider.value}
                                        onChange={fontSizeSlider.handleChange}
                                        onMouseDown={fontSizeSlider.handleMouseDown}
                                        onMouseUp={fontSizeSlider.handleMouseUp}
                                        className="ui-reader-slider flex-1"
                                    />
                                    <button
                                        onClick={fontSizeSlider.increment}
                                        className="inline-flex h-10 w-10 items-center justify-center border border-[var(--color-border)] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)] transition-colors disabled:opacity-30"
                                        aria-label="Increase font size"
                                        disabled={!fontSizeSlider.canIncrement}
                                    >
                                        <Plus className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>

                            <button
                                onClick={() => setShowAdvancedType((prev) => !prev)}
                                className="w-full py-2 text-[10px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)] transition-colors"
                            >
                                {showAdvancedType ? "– Less options" : "+ More options"}
                            </button>

                            {showAdvancedType && (
                                <div className="animate-fade-in space-y-4 pt-4 border-t border-[var(--color-border)]">
                                    <div>
                                        <div className="flex items-center justify-between mb-3">
                                            <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-text-muted)]">Line spacing</span>
                                            <span className="[font-variant-numeric:tabular-nums] text-[11px] text-[color:var(--color-text-primary)]">{lineHeightSlider.value.toFixed(1)}</span>
                                        </div>
                                        <input
                                            type="range"
                                            min={lineHeightSlider.min}
                                            max={lineHeightSlider.max}
                                            step={lineHeightSlider.step}
                                            value={lineHeightSlider.value}
                                            onChange={lineHeightSlider.handleChange}
                                            onMouseDown={lineHeightSlider.handleMouseDown}
                                            onMouseUp={lineHeightSlider.handleMouseUp}
                                            className="ui-reader-slider w-full"
                                        />
                                    </div>

                                    <div>
                                        <span className="block mb-2.5 text-[10px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-text-muted)]">Alignment</span>
                                        <div className="grid grid-cols-3 gap-1.5">
                                            {ALIGN_OPTIONS.map(({ id, label, icon: Icon }) => (
                                                <button
                                                    key={id}
                                                    onClick={() => onUpdate({ textAlign: id })}
                                                    className={cn(
                                                        "relative py-2.5 text-center border transition-colors",
                                                        settings.textAlign === id
                                                            ? "border-[var(--color-text-primary)]"
                                                            : "border-[var(--color-border)] hover:border-[var(--color-text-muted)]"
                                                    )}
                                                    aria-pressed={settings.textAlign === id}
                                                >
                                                    <span className="flex flex-col items-center gap-1">
                                                        <Icon className="w-4 h-4" />
                                                        <span className="text-[10px] font-medium">{label}</span>
                                                    </span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {activeTab === "zoom" && (
                        <div className="space-y-5 pt-1">
                            <div>
                                <div className="flex items-center justify-between mb-3">
                                    <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-text-muted)]">Zoom level</span>
                                    <span className="[font-variant-numeric:tabular-nums] text-[11px] text-[color:var(--color-text-primary)]">{zoomSlider.value}%</span>
                                </div>
                                <div className="flex items-center gap-2.5">
                                    <button
                                        onClick={zoomSlider.decrement}
                                        className="inline-flex h-10 w-10 items-center justify-center border border-[var(--color-border)] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)] transition-colors disabled:opacity-30"
                                        aria-label="Decrease zoom"
                                        disabled={!zoomSlider.canDecrement}
                                    >
                                        <Minus className="w-4 h-4" />
                                    </button>
                                    <input
                                        type="range"
                                        min={zoomSlider.min}
                                        max={zoomSlider.max}
                                        step={zoomSlider.step}
                                        value={zoomSlider.value}
                                        onChange={zoomSlider.handleChange}
                                        onMouseDown={zoomSlider.handleMouseDown}
                                        onMouseUp={zoomSlider.handleMouseUp}
                                        className="ui-reader-slider flex-1"
                                    />
                                    <button
                                        onClick={zoomSlider.increment}
                                        className="inline-flex h-10 w-10 items-center justify-center border border-[var(--color-border)] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)] transition-colors disabled:opacity-30"
                                        aria-label="Increase zoom"
                                        disabled={!zoomSlider.canIncrement}
                                    >
                                        <Plus className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>

                            <div>
                                <span className="block mb-2.5 text-[10px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-text-muted)]">Presets</span>
                                <div className="grid grid-cols-2 gap-1.5">
                                    {[
                                        { id: "actual", label: "100%", value: 100 },
                                        { id: "125", label: "125%", value: 125 },
                                        { id: "150", label: "150%", value: 150 },
                                        { id: "200", label: "200%", value: 200 },
                                    ].map((preset) => (
                                        <button
                                            key={preset.id}
                                            onClick={() => onUpdate({ zoom: preset.value })}
                                            className={cn(
                                                "py-2.5 text-center border text-[11px] font-medium transition-colors",
                                                settings.zoom === preset.value
                                                    ? "border-[var(--color-text-primary)]"
                                                    : "border-[var(--color-border)] hover:border-[var(--color-text-muted)]"
                                            )}
                                            aria-pressed={settings.zoom === preset.value}
                                        >
                                            {preset.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2.5 text-[10px] leading-relaxed text-[color:var(--color-text-secondary)]">
                                This document has a fixed layout. Zoom controls replace text-size options.
                            </div>
                        </div>
                    )}

                    {activeTab === "layout" && (
                        <div className="space-y-5 pt-1">
                            <div>
                                <span className="block mb-2.5 text-[10px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-text-muted)]">Mode</span>
                                <div className="grid grid-cols-2 gap-1.5">
                                    {FLOW_OPTIONS.map(({ id, label, icon: Icon }) => {
                                        const disabled = isFixed && format !== "cbr" && format !== "cbz" && id === "scroll";
                                        const active = !disabled && settings.flow === id;

                                        return (
                                            <button
                                                key={id}
                                                onClick={() => onUpdate({ flow: id })}
                                                className={cn(
                                                    "relative py-4 text-center border transition-colors",
                                                    disabled && "opacity-30 pointer-events-none",
                                                    active
                                                        ? "border-[var(--color-text-primary)]"
                                                        : "border-[var(--color-border)] hover:border-[var(--color-text-muted)]"
                                                )}
                                                aria-pressed={active}
                                                disabled={disabled}
                                            >
                                                <span className="flex flex-col items-center gap-2">
                                                    <Icon className="w-5 h-5" />
                                                    <span className="text-[11px] font-medium">{label}</span>
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            <div>
                                <div className="flex items-center justify-between mb-3">
                                    <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-text-muted)]">Zoom</span>
                                    <span className="[font-variant-numeric:tabular-nums] text-[11px] text-[color:var(--color-text-primary)]">{zoomSlider.value}%</span>
                                </div>
                                <div className="flex items-center gap-2.5">
                                    <button
                                        onClick={zoomSlider.decrement}
                                        className="inline-flex h-10 w-10 items-center justify-center border border-[var(--color-border)] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)] transition-colors disabled:opacity-30"
                                        aria-label="Decrease zoom"
                                        disabled={!zoomSlider.canDecrement}
                                    >
                                        <Minus className="w-4 h-4" />
                                    </button>
                                    <input
                                        type="range"
                                        min={zoomSlider.min}
                                        max={zoomSlider.max}
                                        step={zoomSlider.step}
                                        value={zoomSlider.value}
                                        onChange={zoomSlider.handleChange}
                                        onMouseDown={zoomSlider.handleMouseDown}
                                        onMouseUp={zoomSlider.handleMouseUp}
                                        className="ui-reader-slider flex-1"
                                    />
                                    <button
                                        onClick={zoomSlider.increment}
                                        className="inline-flex h-10 w-10 items-center justify-center border border-[var(--color-border)] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)] transition-colors disabled:opacity-30"
                                        aria-label="Increase zoom"
                                        disabled={!zoomSlider.canIncrement}
                                    >
                                        <Plus className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </FloatingPanel>
        </>
    );
}

export default ReaderSettings;
