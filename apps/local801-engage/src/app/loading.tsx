import { LoadingState } from "@/components/DesignSystem";

export default function Loading() {
  return (
    <div className="content">
      <LoadingState title="Loading your workspace" description="Checking your access and getting the latest available information." />
    </div>
  );
}
