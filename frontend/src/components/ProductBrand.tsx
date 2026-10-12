export const PRODUCT_NAME = "NPA Vessel Caller";

export function ProductBrand({ className = "", subtitle }: { className?: string; subtitle?: string }) {
  return <div className={`product-brand ${className}`.trim()}>
    <img className="product-brand-logo" src="/branding/npa-icon-192.png" width={44} height={44} alt="Nigerian Ports Authority" />
    <span className="product-brand-copy">{PRODUCT_NAME}{subtitle && <small>{subtitle}</small>}</span>
  </div>;
}
