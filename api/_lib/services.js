// The three shipping services the operator can price + ship a box by.
// Server-side source of truth: maps our internal serviceKey to each
// provider's own code so the rate-shopper can match quotes back.
//
//   serviceKey               → our stable id (also stored on shipment_boxes)
//   provider                 → 'usps' | 'ups' (which ShipStation carrier to quote)
//   shipstationServiceCode   → ShipStation V1 serviceCode for this service
//   shippoToken              → Shippo servicelevel.token for this service
//
// The ShipStation *carrierCode* is NOT hard-coded here — it's read from
// app_settings (settings.carriers.{usps,ups}.carrierCode) so it tracks
// whichever Stamps.com / UPS account the operator has connected.
export const SHIPPING_SERVICES = [
  {
    key: 'usps_priority',
    label: 'USPS Priority',
    provider: 'usps',
    shipstationServiceCode: 'usps_priority_mail',
    shippoToken: 'usps_priority',
  },
  {
    key: 'ups_2nd_day_air',
    label: 'UPS 2nd Day Air',
    provider: 'ups',
    shipstationServiceCode: 'ups_2nd_day_air',
    shippoToken: 'ups_second_day_air',
  },
  {
    key: 'ups_next_day_air_saver',
    label: 'UPS Next Day Air Saver',
    provider: 'ups',
    shipstationServiceCode: 'ups_next_day_air_saver',
    shippoToken: 'ups_next_day_air_saver',
  },
];

export const SERVICE_KEYS = SHIPPING_SERVICES.map(s => s.key);
