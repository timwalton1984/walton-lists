// Walton Lists settings. These values are safe to be public.
window.APP_CONFIG = {
  appName: "Walton Lists",

  // The two people allowed to use the app. The toggle shows "Me and <the other person>".
  family: [
    { email: "tjwalton1984@gmail.com", name: "Tim" },
    { email: "daniwalton62@gmail.com", name: "Dani" }
  ],

  firebase: {
    apiKey: "AIzaSyAL4a8KbgVAXZqO5XsOfD5rDjaKXZhsBe4",
    authDomain: "family-lists-a488f.firebaseapp.com",
    projectId: "family-lists-a488f",
    appId: "1:400055078754:web:11038ead8a920f8eb1e63b"
  },

  googleClientId: "400055078754-1hnvfhsidisr605cm7d0q7ao95amsugc.apps.googleusercontent.com",

  // Push notifications. These are safe to be public.
  // vapidPublicKey: the public half of the push signing key (private half lives only in the relay).
  // pushRelayUrl: the Cloudflare Worker that sends the notifications (filled in after it's deployed).
  // pushToken: a simple gate so only this app can call the relay.
  vapidPublicKey: "BO-JPnlxiw4JuLec6ZkEj8gNI1l5zFUdyxAYMTz1JZS48kzS3kKNOgkSWMU2gdhHWjbxUL3f--e_PR2m8oYuXb0",
  pushRelayUrl: "",
  pushToken: "1_tOmrLUAbYFWhJwCZSG3ejjWDnrYx9X"
};
