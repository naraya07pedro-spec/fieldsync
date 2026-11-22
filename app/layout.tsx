import type { Metadata } from 'next';
import './style.css';

export const metadata: Metadata = {
  title: 'FieldSync | Field operations',
  description: 'Project checklists, assignments, and field updates.',
};

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
