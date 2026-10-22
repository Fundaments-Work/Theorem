import { Component, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { reportCaughtError } from "../core/lib/debug";

interface Props {
    children: ReactNode;
    fallback?: ReactNode;
    onReset?: () => void;
}

interface State {
    hasError: boolean;
    error?: Error;
}

export class RouteErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = { hasError: false };
    }

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        void reportCaughtError("RouteErrorBoundary", error, info.componentStack);
    }

    componentDidUpdate(prevProps: Props) {
        if (prevProps.children !== this.props.children && this.state.hasError) {
            this.setState({ hasError: false, error: undefined });
        }
    }

    handleRetry = () => {
        this.setState({ hasError: false, error: undefined });
        this.props.onReset?.();
    };

    render() {
        if (this.state.hasError) {
            if (this.props.fallback) {
                return this.props.fallback;
            }

            return (
                <div className="flex flex-1 h-full w-full items-center justify-center p-6 sm:p-8 animate-fade-in">
                    <div className="mx-auto w-full max-w-[26rem] min-w-0 flex flex-col items-center text-center">
                        <div className="mb-4 flex h-14 w-14 items-center justify-center border border-[var(--color-border)] bg-[var(--color-surface)] text-[color:var(--color-error)]">
                            <AlertCircle className="h-6 w-6" />
                        </div>
                        <h2 className="mb-2 text-base text-[color:var(--color-text-primary)]">
                            This page encountered an error
                        </h2>
                        <p className="mx-auto w-full max-w-[22rem] break-words text-sm text-[color:var(--color-text-secondary)] mb-6 leading-relaxed">
                            {this.state.error?.message ?? "An unexpected error occurred."}
                        </p>
                        <button
                            onClick={this.handleRetry}
                            className="px-5 py-2.5 text-xs bg-[var(--color-surface)] text-[color:var(--color-text-primary)] border border-[var(--color-border)] hover:bg-[var(--color-surface-muted)] transition-colors"
                        >
                            Try Again
                        </button>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}
