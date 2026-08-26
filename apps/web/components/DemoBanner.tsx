export default function DemoBanner() {
  return (
    <div className="rounded-sm border border-material/40 bg-material/10 px-3 py-2 text-2xs text-material">
      <strong className="font-mono uppercase tracking-wide">Synthetic corpus</strong> — no settled
      council session exists in this environment yet. This is demo data built to exercise the
      scoring honestly (each persona has a deliberately different pathology), not a claim about real
      performance. It disappears the moment a real session settles.
    </div>
  );
}
