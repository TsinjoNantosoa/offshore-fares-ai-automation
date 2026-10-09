'use strict';
/**
 * FareProvider – adapter contract between the RFQ engine and any fare source.
 *
 *   searchFlights(request)  -> Promise<FareOption[]>   (request = RFQ requirements)
 *   getFareRules(option)    -> Promise<{ change_penalty, refund_penalty, baggage, raw }>
 *   revalidateFare(option)  -> Promise<{ still_valid, amount, currency, valid_until }>
 *
 * Implementations:
 *   ManualFareProvider  – fare desk enters options (current production path)
 *   MockFareProvider    – deterministic demo data (DEMO_MODE only, clearly labelled)
 *   Amadeus / Sabre / Travelport / NDC / consolidator – NOT implemented on purpose:
 *   they require commercial agreements and credentials from Offshore Fares.
 *   See docs/future-integrations.md for the integration plan.
 */

class NotConfiguredError extends Error {
  constructor(provider) {
    super(`${provider} is not configured. Provide API credentials and implement the adapter (see docs/future-integrations.md).`);
    this.code = 'FARE_PROVIDER_NOT_CONFIGURED';
  }
}

class FareProvider {
  constructor(name) { this.name = name; }
  async searchFlights() { throw new NotConfiguredError(this.name); }
  async getFareRules() { throw new NotConfiguredError(this.name); }
  async revalidateFare() { throw new NotConfiguredError(this.name); }
}

/** Human fare desk: searches happen in the GDS terminal, results are typed into the Mock Fare Desk form. */
class ManualFareProvider extends FareProvider {
  constructor() { super('ManualFareProvider'); }
  async searchFlights() { return { status: 'MANUAL_ENTRY_REQUIRED', options: [] }; }
  async revalidateFare(option) { return { status: 'MANUAL_RECHECK_REQUIRED', option_code: option.option_code }; }
}

class AmadeusFareProvider extends FareProvider { constructor() { super('AmadeusFareProvider'); } }
class SabreFareProvider extends FareProvider { constructor() { super('SabreFareProvider'); } }
class TravelportFareProvider extends FareProvider { constructor() { super('TravelportFareProvider'); } }

module.exports = { FareProvider, ManualFareProvider, AmadeusFareProvider, SabreFareProvider, TravelportFareProvider, NotConfiguredError };
