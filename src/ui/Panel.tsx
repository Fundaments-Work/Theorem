
import { cn } from '../core/lib/utils';
import { ReactNode } from 'react';

export type PanelPosition = 'left' | 'right';

interface PanelProps {
    visible: boolean;
    children: ReactNode;
    position?: PanelPosition;
    width?: string;
    className?: string;
    header?: ReactNode;
}

export function Panel({
    visible,
    children,
    position = 'right',
    width = 'w-80',
    className,
    header,
}: PanelProps) {
    const isLeft = position === 'left';

    return (
        <div
            className={cn(
                'fixed top-0 h-full max-w-[var(--layout-reader-panel-max-width-mobile)] z-[var(--z-dropdown)] flex flex-col',
                'transform transition-transform duration-240 ease-[cubic-bezier(0.16,1,0.3,1)]',
                isLeft ? 'left-0 border-r-2' : 'right-0 border-l-2',
                visible
                    ? 'translate-x-0'
                    : isLeft ? '-translate-x-full' : 'translate-x-full',
                width,
                className
            )}
            style={{
                backgroundColor: 'var(--reader-bg, var(--color-surface))',
                borderColor: 'color-mix(in srgb, var(--reader-fg, var(--color-text)) 15%, transparent)',
            }}
        >
            {header && (
                <div 
                    className="flex items-center justify-between p-5 border-b-2"
                    style={{ borderColor: 'color-mix(in srgb, var(--reader-fg, var(--color-text)) 15%, transparent)' }}
                >
                    {header}
                </div>
            )}
            {children}
        </div>
    );
}

interface FloatingPanelProps {
    visible: boolean;
    children: ReactNode;
    className?: string;
    anchor?: 'top-left' | 'top-right' | 'bottom';
}

export function FloatingPanel({
    visible,
    children,
    className,
    anchor = 'top-right',
}: FloatingPanelProps) {
    const isBottom = anchor === 'bottom';
    return (
        <div
            role="dialog"
            aria-modal="true"
            className={cn(
                'fixed z-[150] flex flex-col reader-sheet border-2',
                
                'left-0 right-0 bottom-0 max-h-[var(--layout-floating-panel-max-height)]',
                
                isBottom
                    ? 'sm:top-auto sm:bottom-5 sm:left-auto sm:right-5 sm:max-h-[var(--layout-floating-panel-max-height-desktop)] sm:w-[var(--layout-floating-panel-width)]'
                    : 'sm:bottom-auto sm:top-[var(--layout-floating-panel-top-offset)] sm:max-h-[var(--layout-floating-panel-max-height-desktop)] sm:w-[var(--layout-floating-panel-width)]',
                !isBottom && anchor === 'top-right' && 'sm:left-auto sm:right-5',
                !isBottom && anchor === 'top-left' && 'sm:left-5 sm:right-auto',
                
                'transform transition-[transform,opacity] duration-240 ease-[cubic-bezier(0.22,1,0.36,1)]',
                visible
                    ? 'translate-y-0 opacity-100'
                    : isBottom
                        ? 'translate-y-8 opacity-0 pointer-events-none'
                        : 'translate-y-8 opacity-0 pointer-events-none sm:-translate-y-2',
                className
            )}
        >
            {children}
        </div>
    );
}
