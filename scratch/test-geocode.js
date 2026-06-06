const url = "https://services.nconemap.gov/secure/rest/services/AddressNC/AddressNC_geocoder/GeocodeServer/findAddressCandidates?SingleLine=" + encodeURIComponent("529 Flat Rock Cemetery Rd, Mount Holly, NC 28120") + "&outSR=4326&f=json";

fetch(url)
  .then(res => res.json())
  .then(data => {
    console.log(JSON.stringify(data, null, 2));
  })
  .catch(err => console.error(err));
