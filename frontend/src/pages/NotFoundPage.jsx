import Button from '../components/ui/Button';

export default function NotFoundPage() {
  return (
    <div className="min-h-screen bg-white flex items-center justify-center p-6">
      <div className="text-center">
        <h1 className="font-radio-canada font-bold text-hero text-text-primary mb-4">404</h1>
        <p className="font-source-serif text-body-lg text-text-muted mb-8">Page not found</p>
        <Button variant="primary" to="/">Go Home</Button>
      </div>
    </div>
  );
}
