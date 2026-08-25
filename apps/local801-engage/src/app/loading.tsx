import { LoadingState } from "@/components/DesignSystem";

export default function Loading() {
  return (
    <div className="content">
      <LoadingState title="Opening CAT" description="Checking your access and loading the latest information." />
    </div>
  );
}
