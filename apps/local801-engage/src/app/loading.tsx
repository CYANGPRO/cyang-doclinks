import { LoadingState } from "@/components/DesignSystem";

export default function Loading() {
  return (
    <div className="content">
      <LoadingState title="Loading workspace" description="Retrieving the latest authorized information." />
    </div>
  );
}
