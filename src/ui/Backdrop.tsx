
import { cn } from '../core/lib/utils';

interface BackdropProps {
    visible: boolean;
    onClick?: () => void;
    className?: string;
    blur?: boolean;
    /** False for panels that change the page behind them (reading settings): the page stays visible so the change can be seen. */
    dim?: boolean;
}

export function Backdrop({ visible, onClick, className, blur = false, dim = true }: BackdropProps) {
    if (!visible) return null;

    return (
        <div
            className={cn(
                'fixed inset-0 z-[var(--z-backdrop)] transition-opacity duration-200',
                dim && 'bg-[var(--color-overlay-medium)] sm:bg-[var(--color-overlay-strong)]',
                dim && blur && 'backdrop-blur-[var(--effect-backdrop-blur-sm)]',
                className
            )}
            onClick={onClick}
        />
    );
}


