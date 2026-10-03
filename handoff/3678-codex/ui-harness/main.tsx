import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionProvider } from 'next-auth/react';
import { FeesPageClient } from '@/app/(admin)/admin/fees/_components/fees-page-client';
import { PublicBookingRequestsPanel } from '@/components/admin/booking-requests/public-booking-requests-panel';
import { RefundAppealButton } from '@/components/refund-appeal-button';
import { ClubFormatProvider } from '@/components/club-format-provider';
import { ClubTimeProvider } from '@/components/club-time-provider';
import { ClubIdentityProvider } from '@/components/club-identity-provider';
import { MoneyInput } from '@/components/ui/money-input';

const readonly = new URLSearchParams(location.search).get('view') === 'readonly';
const blocked = new URLSearchParams(location.search).get('view') === 'blocked';
const events: any[] = [];
(window as any).__uiEvidence = { events, unexpected: [], errors: [], submissions: 0, sha: __UI_SHA__ };
window.addEventListener('error', event => (window as any).__uiEvidence.errors.push(event.message));
window.addEventListener('unhandledrejection', event => (window as any).__uiEvidence.errors.push(String(event.reason)));

const ageTiers = [
  { tier: 'INFANT', minAge: 0, maxAge: 4, label: 'Infant (under 5)', sortOrder: 0 },
  { tier: 'CHILD', minAge: 5, maxAge: 9, label: 'Child (5–9)', sortOrder: 1 },
  { tier: 'YOUTH', minAge: 10, maxAge: 17, label: 'Youth (10–17)', sortOrder: 2 },
  { tier: 'ADULT', minAge: 18, maxAge: null, label: 'Adult (18+)', sortOrder: 3 },
];
const membershipTypes = [
  { id: 'full', key: 'FULL', name: 'Full membership', bookingBehavior: 'MEMBER_RATE', ageGroupsApply: true, isActive: true },
  { id: 'non-member', key: 'NON_MEMBER', name: 'Non-Member', bookingBehavior: 'NON_MEMBER_RATE', ageGroupsApply: true, isActive: true },
  { id: 'family', key: 'FAMILY', name: 'Family membership', bookingBehavior: 'MEMBER_RATE', ageGroupsApply: true, isActive: true },
];
const season = { id: 'ui-season', name: 'Winter UI fixture', type: 'WINTER', startDate: '2026-06-01T00:00:00.000Z', endDate: '2027-05-31T00:00:00.000Z', active: true, flatWholeLodgeNightCents: 35045, membershipTypeRates: membershipTypes.flatMap((type, index) => ageTiers.map((tier, i) => ({ membershipTypeId: type.id, ageTier: tier.tier, pricePerNightCents: 3505 + index * 1000 + i * 100 }))) };
const fee = { id: 'annual-full', ageTier: null, amountCents: 25050, effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null, billingBasis: 'PER_MEMBER', prorationRule: 'REMAINING_MONTHS_INCLUSIVE', components: [
  { id: 'comp-a', label: 'Annual membership', amountCents: 20025, prorate: true, xeroAccountCode: '200', xeroItemCode: null, sortOrder: 0 },
  { id: 'comp-b', label: 'Work party contribution', amountCents: 5025, prorate: false, xeroAccountCode: '200', xeroItemCode: null, sortOrder: 1 },
] };
const request = {
  id: 'ui-school', type: 'SCHOOL', status: 'PRICED', schoolName: 'Synthetic School', exclusivityRequested: false, requestedByMemberId: null, requestedByMemberName: null,
  lodgeId: 'ui-lodge', lodgeName: null, otherLodgeId: null, otherLodgeName: null, schoolGroupSoftCap: 30, cateringPreference: 'QUOTE_BOTH', pendingAdultCount: 1, pendingAdultsWriteEnabled: true,
  suggestedGuestNightRates: Object.fromEntries(ageTiers.map((tier, i) => [tier.tier, { nonMemberCents: 3505 + i * 100, memberCents: 2005 + i * 100 }])),
  teachers: [{ firstName: 'Ada', lastName: 'Example', email: 'ada@example.test' }], linkedGuestMembers: [{ guestIndex: 0, memberId: 'ui-member' }],
  contactFirstName: 'Ada', contactLastName: 'Example', contactEmail: 'ada@example.test', contactPhone: null, checkIn: '2026-08-01', checkOut: '2026-08-03',
  guests: [{ firstName: 'Ada', lastName: 'Example', ageTier: 'ADULT' }, ...ageTiers.filter(tier => tier.tier !== 'ADULT').map((tier, i) => ({ firstName: 'Student', lastName: String(i + 1), ageTier: tier.tier }))],
  message: 'Synthetic fixture for dense quote controls; no real people or providers.', indicativePriceCents: 100055, priceCents: 100055, verifiedAt: null, pricedAt: null, pricedByMemberId: null, pricedByMemberName: null,
  reviewedAt: null, reviewedByMemberId: null, reviewedByMemberName: null, declineReason: null, convertedBookingId: null, attendeesConfirmedAt: null, convertedMemberId: null, heldBookingId: null, heldBookingStatus: null,
  version: 1, acceptedQuoteOptionId: null, acceptedPriceCents: null, acceptedAt: null, responseMessage: null, responseMessageAt: null, createdAt: '2026-07-01T00:00:00.000Z',
  latestQuote: { id: 'ui-quote', version: 1, status: 'DRAFT', pricingMode: 'OVERALL_TOTAL', sentAt: null, responseTokenExpiresAt: null, options: [
    { id: 'CATERED', label: 'Catered', totalCents: 100055, cateringOption: 'CATERED' },
    { id: 'NON_CATERED', label: 'Non-catered', totalCents: 80055, cateringOption: 'NON_CATERED' },
  ] },
};

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
  const method = init?.method || 'GET';
  events.push({ path: url.pathname, method, body: init?.body ? JSON.parse(String(init.body)) : null });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.origin !== location.origin) throw new Error(`External request refused: ${url.origin}`);
  if (url.pathname === '/api/admin/fee-configuration') return json({ canEdit: !readonly, familyBillingMode: 'BILL_FAMILY_VIA_BILLING_MEMBER', defaultInvoiceAccountCode: '200', membershipTypes: membershipTypes.map((type, i) => ({ ...type, annualFees: i === 0 ? [fee] : [], joiningFees: [{ id: `joining-${i}`, amountCents: 7505, effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null, ageTier: null }] })), familyGroups: [] });
  if (url.pathname === '/api/admin/xero/chart-of-accounts') return json({ accounts: [{ code: '200', name: 'Membership income', type: 'REVENUE', status: 'ACTIVE' }] });
  if (url.pathname === '/api/admin/xero/items') return json({ items: [] });
  if (url.pathname === '/api/admin/membership-types') return json({ membershipTypes });
  if (url.pathname === '/api/admin/age-tier-settings') return json({ settings: ageTiers });
  if (url.pathname === '/api/admin/seasons') return json(method === 'GET' ? [season] : { ...season, ...(events.at(-1).body || {}) });
  if (url.pathname === '/api/admin/seasons/ui-season') return json({ ...season, ...(events.at(-1).body || {}) });
  if (url.pathname === '/api/lodges' || url.pathname === '/api/admin/lodges') return json({ lodges: [{ id: 'ui-lodge', name: 'Synthetic Lodge', active: true, travelNote: '' }] });
  if (url.pathname === '/api/admin/booking-requests') return json({ data: [blocked ? { ...request, quoteDataNeedsAttention: true, latestQuote: { ...request.latestQuote, options: [] } } : request] });
  if (url.pathname.endsWith('/contacts')) return json({ contacts: [] });
  if (url.pathname.endsWith('/link-conflicts')) return json({ conflicts: [] });
  if (url.pathname.endsWith('/quote')) return json({ ok: true });
  if (url.pathname === '/api/bookings/ui-booking/refund-request') return json(method === 'GET' ? [] : { id: 'ui-appeal', status: 'PENDING', ...events.at(-1).body, approvedAmountCents: null, adminNotes: null, createdAt: '2026-07-01T00:00:00.000Z', reviewedAt: null });
  (window as any).__uiEvidence.unexpected.push({ path: url.pathname, method });
  throw new Error(`Unmocked local fixture request: ${method} ${url.pathname}`);
};

function BoundaryFixture() {
  const [normal, setNormal] = useState('12.34');
  const [signed, setSigned] = useState('-1.50');
  return <section aria-label="Supplementary MoneyInput boundary fixture" className="space-y-4">
    <h1 className="text-xl font-semibold">Supplementary control boundary</h1>
    <form onSubmit={event => { event.preventDefault(); (window as any).__uiEvidence.submissions++; }} className="space-y-4">
      <MoneyInput label="Form amount" value={normal} onValueChange={setNormal} className="w-32" />
      <MoneyInput label="Signed adjustment" value={signed} onValueChange={setSigned} allowNegative className="w-32" />
      <MoneyInput label="Disabled amount" value="12.34" onValueChange={() => { throw new Error('Disabled changed'); }} disabled className="w-32" />
      <MoneyInput label="Read only amount" value="12.34" onValueChange={() => { throw new Error('Read only changed'); }} readOnly className="w-32" />
      <button type="submit" className="rounded border p-2">Explicit fixture submit</button>
    </form>
  </section>;
}

const identity = { name: 'Synthetic Club', shortName: 'Synthetic', supportEmail: 'support@example.test', contactEmail: 'contact@example.test', publicUrl: 'htt[historical local path omitted]', emailFromName: 'Synthetic', lodgeTravelNote: '', hutLeaderLabel: 'Hut Leader', socialLinks: {}, bookingsName: 'Synthetic Bookings', lodgeName: 'Synthetic Lodge', publicHost: '127.0.0.1', lodgeCapacity: 30 };
const session = { expires: '2099-01-01T00:00:00.000Z', user: { id: 'ui-admin', name: 'Synthetic Admin', email: 'admin@example.test', canLogin: true, accessRoles: ['ADMIN'] } };
const surface = location.pathname.split('/')[1] || 'fees';
createRoot(document.getElementById('root')!).render(
  <SessionProvider session={session as any} refetchOnWindowFocus={false}>
    <ClubIdentityProvider value={identity}><ClubFormatProvider currencyCode="NZD" locale="en-NZ"><ClubTimeProvider zone="Pacific/Auckland" locale="en-NZ">
      <main className={surface === 'refund' ? 'mx-auto max-w-3xl p-4' : 'mx-auto max-w-7xl p-4'}>
        {surface === 'fees' ? <FeesPageClient hutFeesCanEdit={!readonly} financeCanEdit={!readonly} /> : surface === 'quotes' ? <PublicBookingRequestsPanel basePath="/quotes" canEdit={!readonly} /> : surface === 'refund' ? <RefundAppealButton bookingId="ui-booking" maxRefundableCents={10000} /> : <BoundaryFixture />}
      </main>
    </ClubTimeProvider></ClubFormatProvider></ClubIdentityProvider>
  </SessionProvider>,
);

