import { PageHeader } from 'theorem';

export function Default() {
    return <PageHeader title="Library" description="42 books · 3 currently reading" />;
}

export function WithActions() {
    return (
        <PageHeader title="Vocabulary" description="Words you've looked up while reading">
            <button type="button" className="ui-btn-ghost">Export</button>
            <button type="button" className="ui-btn-primary">Add word</button>
        </PageHeader>
    );
}
